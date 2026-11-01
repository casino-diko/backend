/*
 |--------------------------------------------------------------------------
 | rounds
 |--------------------------------------------------------------------------
 | The rounds list (every table of every game), one round with its bets, and
 | voiding a resulted round.
 |
 | List: each game's rounds are filtered, joined with their bets and sorted
 | in MongoDB; like the player page, every game returns only its first
 | page × size rows and the merge (compareRows) holds the page exactly.
 | Totals come from each game in full.
 |
 |   payout   : winnings paid, stake included (E: total_win; V: what was
 |              paid before the void, bets.reversed)
 |   net      : house result, bets - payout (E only; C and V end even)
 |   refunded : stakes given back (C: by the game-server; V: by the void)
 |
 | Void (status E -> V, admin only): in one transaction the flip to V
 | (guarded on E, so a round is reversed once), every bet rolled back
 | (lib/voidPlan.ts: balance += stake - total_win, may go negative), a
 | signed `rollback` transaction per transfer player, a queued vendor call
 | per seamless player (vendor_calls, like the game-server's refunds), and
 | the round's mark off the road map. Then the table's players are told
 | (voidEvent): `displayRollback` when their road maps can be corrected live,
 | `roundvoided` (a notice) otherwise.
 |
 */

import type { ClientSession } from 'mongoose';
import { GAME_LABELS, GAMES, type Game } from './config';
import { getDb, type Db } from './db';
import { dateRange } from './listQuery';
import { compareRows } from './activityQuery';
import { publishGameEvent } from './redis';
import { roundGames, statusMatch, type RoundQuery, type Sort } from './roundQuery';
import { Invalid } from './validate';
import { planVoid, PlanError, round2, type VoidRow } from './voidPlan';

// path segment of the vendors' API (/api/transact/<game>/<type>), as the player site uses it
const API_GAME: Record<Game, string> = { baccarat : 'baccarat', dragontiger : 'dragon-tiger', poker : 'poker' };

const SORT_FIELDS: Record<Sort, string> = {
	time : 'created_at', round : 'round_num', players : 'players', bets : 'bets', payout : 'payout', net : 'net', refunded : 'refunded'
};

export type RoundRow = {
	game       : Game;
	_id        : number;
	table_id   : number;
	round_num  : number;
	shoe_id?   : number;
	dealer_id? : number;
	status     : string;
	created_at : Date;
	game_info  : any;
	game_result: any;
	closed?    : any;
	players    : number;
	bets       : number;
	payout     : number;
	net        : number;
	refunded   : number;
	reversed   : number;
};

export type RoundList = {
	rows    : RoundRow[];
	total   : number;
	pages   : number;
	page    : number;
	totals  : { bets : number; payout : number; net : number; refunded : number; reversed : number };
	counts  : Record<string, number>;        // per status (E C V open) over the other filters
	dealers : Map<number, { name : string; code : string }>;
	tables  : { game : Game; id : number; name : string }[];
};

const isE = { $eq : ['$status', 'E'] };
const isV = { $eq : ['$status', 'V'] };

// the round's bets folded into players / bets / payout / net / refunded / reversed
const withBets = [
	{ $lookup : { from : 'bets', localField : '_id', foreignField : 'round_id', as : 'b',
		pipeline : [{ $project : { user_id : 1, total_bet : 1, total_win : 1, refunded : 1, reversed : 1 } }] } },
	{ $set : {
		players  : { $size : { $setUnion : ['$b.user_id', []] } },
		bets     : { $sum : '$b.total_bet' },
		paidE    : { $sum : '$b.total_win' },
		paidV    : { $sum : '$b.reversed' },
		refunded : { $cond : [{ $in : ['$status', ['C', 'V']] }, { $sum : '$b.refunded' }, 0] }
	} },
	{ $set : {
		payout   : { $cond : [isE, '$paidE', { $cond : [isV, '$paidV', 0] }] },
		net      : { $cond : [isE, { $subtract : ['$bets', '$paidE'] }, 0] },
		reversed : { $cond : [isV, '$paidV', 0] }
	} },
	{ $project : { b : 0, paidE : 0, paidV : 0 } }
];

function roundMatch (query: RoundQuery, withStatus = true): any {
	const match: any = {};
	if (query.table) match.table_id = query.table;
	if (query.dealer) match.dealer_id = query.dealer;
	if (query.round) match.round_num = query.round;
	const created = dateRange(query);
	if (created) match.created_at = created;
	const status = withStatus ? statusMatch(query.status) : null;
	if (status) match.status = status;
	return match;
}

export async function listRounds (query: RoundQuery): Promise<RoundList> {
	const db = await getDb();
	const games = roundGames(query);

	const [tables, dealerDocs] = await Promise.all([
		Promise.all(GAMES.map(async game => (await db.games[game].tables.find({ deleted_at : null }, { env_setting : 1 }).sort({ _id : 1 }).lean())
			.map((t: any) => ({ game, id : t._id as number, name : t.env_setting?.table_name || `Table ${t._id}` })))),
		db.shared.dealers.find({}, { name : 1, real_name : 1, code : 1 }).sort({ _id : 1 }).lean()
	]);
	const dealers = new Map<number, { name : string; code : string }>(dealerDocs.map((d: any) => [d._id, { name : d.real_name || d.name || `#${d._id}`, code : d.code || '' }]));

	const match = roundMatch(query);
	const metas = await Promise.all(games.map(game => db.games[game].rounds.aggregate([
		{ $match : match },
		...withBets,
		{ $group : { _id : null, total : { $sum : 1 }, bets : { $sum : '$bets' }, payout : { $sum : '$payout' }, net : { $sum : '$net' }, refunded : { $sum : '$refunded' }, reversed : { $sum : '$reversed' } } }
	])));
	const sum = (key: string) => round2(metas.reduce((t, [m]) => t + (m ? m[key] || 0 : 0), 0));

	// per-status counts for the filter chips (cheap: rounds only)
	const countRows = await Promise.all(games.map(game => db.games[game].rounds.aggregate([
		{ $match : roundMatch(query, false) },
		{ $group : { _id : '$status', n : { $sum : 1 } } }
	])));
	const counts: Record<string, number> = { all : 0, E : 0, C : 0, V : 0, open : 0 };
	for (const rows of countRows) for (const r of rows) {
		counts.all += r.n;
		counts[['S', 'P', 'H'].includes(r._id) ? 'open' : r._id] = (counts[['S', 'P', 'H'].includes(r._id) ? 'open' : r._id] || 0) + r.n;
	}

	const total = sum('total');
	const pages = Math.max(1, Math.ceil(total / query.size));
	const page = Math.min(query.page, pages);
	const result: RoundList = {
		rows : [], total, pages, page, counts, dealers, tables : tables.flat(),
		totals : { bets : sum('bets'), payout : sum('payout'), net : sum('net'), refunded : sum('refunded'), reversed : sum('reversed') }
	};
	if (!total) return result;

	const dir = query.dir === 'asc' ? 1 : -1;
	const field = SORT_FIELDS[query.sort];
	const sort: Record<string, 1 | -1> = field === 'created_at' ? { created_at : dir, _id : dir } : { [field] : dir, created_at : dir, _id : dir };
	const need = page * query.size;
	// time and round number are on the round: sort and cut before joining the bets
	const onRound = field === 'created_at' || field === 'round_num';

	const lists = await Promise.all(games.map(async game => {
		const docs: any[] = await db.games[game].rounds.aggregate(onRound
			? [{ $match : match }, { $sort : sort }, { $limit : need }, ...withBets]
			: [{ $match : match }, ...withBets, { $sort : sort }, { $limit : need }]);
		return docs.map(doc => ({
			row   : { ...doc, game } as RoundRow,
			order : { sortValue : field === 'created_at' ? null : doc[field] ?? null, at : new Date(doc.created_at).getTime() || 0, source : game, id : doc._id }
		}));
	}));

	result.rows = lists.flat()
		.sort((a, b) => compareRows(a.order, b.order, query.dir))
		.slice((page - 1) * query.size, need)
		.map(x => x.row);
	return result;
}

// ------------------------------------------------------------------ one round

export type RoundBet = {
	_id      : number;
	user     : { _id : number; user_id : string; user_name : string } | null;
	wallet   : 'transfer' | 'seamless' | '?';
	areas    : { area : string; stake : number; win : number }[];
	stake    : number;
	payout   : number | null;
	status   : string;
	refunded : number | null;
};

export type RoundDetail = {
	game     : Game;
	round    : any;
	table    : string;
	dealer   : string;
	bets     : RoundBet[];
	plan     : VoidRow[] | null;       // E only: what a void would move
	planError: string | null;
	tx       : any[];                  // refund / rollback transactions of the round
	calls    : any[];                  // queued vendor calls of the round
};

/** bet_history: [{ bet, bet_money, win_money }] (baccarat, dragon-tiger) or { ante : { bet, win }, ... } (poker) */
function betAreas (history: any): { area : string; stake : number; win : number }[] {
	if (Array.isArray(history)) {
		return history.map(h => ({ area : String(h.bet ?? '').replace(/^bet_/, '').replace(/_/g, ' '), stake : Number(h.bet_money) || 0, win : Number(h.win_money) || 0 }));
	}
	if (history && typeof history === 'object') {
		return Object.entries(history)
			.filter(([, v]: any) => v && typeof v === 'object' && Number(v.bet))
			.map(([k, v]: any) => ({ area : k, stake : Number(v.bet) || 0, win : Number(v.win) || 0 }));
	}
	return [];
}

export async function getRound (game: Game, id: number): Promise<RoundDetail | null> {
	const db = await getDb();
	const g = db.games[game];
	const round: any = await g.rounds.findById(id).lean();
	if (!round) return null;

	const [table, dealer, bets]: any[] = await Promise.all([
		g.tables.findById(round.table_id, { env_setting : 1 }).lean(),
		round.dealer_id ? db.shared.dealers.findById(round.dealer_id, { name : 1, real_name : 1, code : 1 }).lean() : null,
		g.bets.find({ round_id : id }).sort({ _id : 1 }).lean()
	]);
	const users = new Map<number, any>((await db.shared.users.find({ _id : { $in : bets.map((b: any) => b.user_id) } }, { user_id : 1, user_name : 1, vendor_id : 1, money : 1 }).lean()).map((u: any) => [u._id, u]));
	const vendors = new Map<number, any>((await db.shared.vendors.find({ _id : { $in : [...users.values()].map(u => u.vendor_id) } }, { integration_type : 1, vendor_name : 1 }).lean()).map((v: any) => [v._id, v]));

	let plan: VoidRow[] | null = null;
	let planError: string | null = null;
	if (round.status === 'E') {
		try {
			plan = planVoid(bets, users, vendors);
		} catch (e) {
			planError = e instanceof PlanError ? e.message : 'The void preview could not be computed';
		}
	}

	const [tx, calls] = await Promise.all([
		db.shared.transactions.find({ game, round_id : id }).sort({ _id : 1 }).lean(),
		db.shared.vendorCalls.find({ _id : { $regex : `^${game}:` }, 'body.round_no' : round.round_num, 'body.table' : round.table_id }).sort({ created_at : 1 }).lean()
	]);

	return {
		game, round, plan, planError, tx, calls,
		table  : table?.env_setting?.table_name || `Table ${round.table_id}`,
		dealer : dealer ? `${dealer.real_name || dealer.name} (${dealer.code})` : round.dealer_id ? `#${round.dealer_id}` : '',
		bets   : bets.map((b: any) => {
			const u = users.get(b.user_id);
			const v = u ? vendors.get(u.vendor_id) : null;
			const settled = round.status === 'E';
			return {
				_id      : b._id,
				user     : u ? { _id : u._id, user_id : u.user_id, user_name : u.user_name } : null,
				wallet   : v ? (v.integration_type === 'seamless' ? 'seamless' : 'transfer') : '?',
				areas    : betAreas(b.bet_history),
				stake    : Number(b.total_bet) || 0,
				payout   : settled ? Number(b.total_win) || 0 : round.status === 'V' ? Number(b.reversed) || 0 : null,
				status   : b.status || (settled ? 'settled' : round.status === 'C' ? 'refunded' : 'open'),
				refunded : b.refunded ?? null
			};
		})
	};
}

// ------------------------------------------------------------------ void

export type VoidResult = { roundNum : number; rows : VoidRow[]; mark : 'removed' | 'not found'; told : 'road map' | 'notice' | 'not sent' };

/** takes the round's mark off its road map; resolves the removed mark and the road map document it was in */
async function removeMark (game: Game, g: Db['games'][Game], round: any, session: ClientSession): Promise<{ mark : any; docId : number } | null> {
	if (game === 'poker') {
		const doc: any = await g.gameMarks.findOneAndDelete({ table_id : round.table_id, round_id : round._id }, { session }).lean();
		return doc ? { mark : { round_id : round._id, mark : doc.mark }, docId : doc._id } : null;
	}

	// marks written since voids exist carry their round_id
	const doc: any = await g.gameMarks.findOne({ table_id : round.table_id, 'mark.round_id' : round._id }, { mark : { $elemMatch : { round_id : round._id } } }).session(session).lean();
	if (doc) {
		await g.gameMarks.updateOne({ _id : doc._id }, { $pull : { mark : { round_id : round._id } } }, { session });
		return { mark : doc.mark[0], docId : doc._id };
	}

	// older marks: the round's place among its shoe's results (baccarat rounds keep the shoe id)
	if (!round.shoe_id) return null;
	const shoe: any = await g.gameMarks.findOne({ _id : round.shoe_id, table_id : round.table_id }, { mark : 1 }).session(session).lean();
	if (!shoe || !Array.isArray(shoe.mark)) return null;
	const index = await g.rounds.countDocuments({ table_id : round.table_id, shoe_id : round.shoe_id, status : 'E', round_num : { $lt : round.round_num } }).session(session);
	const mark = shoe.mark[index];
	if (!mark || mark.round_id) return null;
	await g.gameMarks.updateOne({ _id : shoe._id }, { $unset : { [`mark.${index}`] : 1 } }, { session });
	await g.gameMarks.updateOne({ _id : shoe._id }, { $pull : { mark : null } }, { session });
	return { mark, docId : shoe._id };
}

/**
 * What the table's players are sent. Baccarat's pages (and the socket-server's store) take
 * `data.mark` as the shoe's whole corrected road map, so any void in the current shoe redraws
 * it. Dragon-tiger and poker pages drop their last mark, which is right only for the table's
 * latest result; `data.mark` must then be one mark, not an array (the store would take an
 * array as the whole road map). Otherwise `roundvoided`: a notice, the road map is right on
 * the next visit.
 */
async function voidEvent (game: Game, g: Db['games'][Game], tableId: number, removed: { mark : any; docId : number } | null, latest: boolean) {
	if (!removed) return { eventName : 'roundvoided' };
	if (game === 'baccarat') {
		const shoe: any = await g.gameMarks.findOne({ table_id : tableId }, { mark : 1 }).sort({ _id : -1 }).lean();
		return shoe && shoe._id === removed.docId
			? { eventName : 'displayRollback', data : { mark : shoe.mark || [] } }
			: { eventName : 'roundvoided' };
	}
	return latest ? { eventName : 'displayRollback', data : { mark : removed.mark } } : { eventName : 'roundvoided' };
}

export async function voidRound (game: Game, roundId: number, reason: string, admin: string): Promise<VoidResult> {
	const db = await getDb();
	const g = db.games[game];
	const s = db.shared;

	const done = await db.withTransaction(async session => {
		const round: any = await g.rounds.findOneAndUpdate(
			{ _id : roundId, status : 'E' },
			{ $set : { status : 'V', closed : { action : 'void', reason, admin, at : new Date() } } },
			{ new : true, session }
		).lean();
		if (!round) {
			const now: any = await g.rounds.findById(roundId, { status : 1 }).session(session).lean();
			throw new Invalid(!now ? 'Round not found' : now.status === 'V' ? 'This round is already voided' : 'Only successful rounds can be voided');
		}

		const bets: any[] = await g.bets.find({ round_id : roundId }).session(session).lean();
		const users = new Map<number, any>((await s.users.find({ _id : { $in : bets.map(b => b.user_id) } }, { vendor_id : 1, user_id : 1, user_name : 1, money : 1, currency : 1 }).session(session).lean()).map((u: any) => [u._id, u]));
		const vendors = new Map<number, any>((await s.vendors.find({ _id : { $in : [...users.values()].map(u => u.vendor_id) } }, { integration_type : 1, vendor_name : 1, currency : 1 }).session(session).lean()).map((v: any) => [v._id, v]));

		let rows: VoidRow[];
		try {
			rows = planVoid(bets, users, vendors);
		} catch (e) {
			if (e instanceof PlanError) throw new Invalid(e.message);
			throw e;
		}

		if (rows.length) {
			await g.bets.bulkWrite(rows.map(r => ({
				updateOne : {
					filter : { _id : r.betId, status : { $nin : ['refunded', 'rolled_back'] } },
					// total_win becomes the stake, so players' bet histories show the bet as even
					update : { $set : { status : 'rolled_back', refunded : r.stake, reversed : r.paid, total_win : r.stake, total_winning : 0, total_lost : 0 } }
				}
			})), { session });
		}

		const note = `Round ${round.round_num} voided: ${reason}`;
		for (const r of rows) {
			const user = users.get(r.userId);
			const vendor = vendors.get(r.vendorId);
			const bet = bets.find(b => b._id === r.betId);
			if (r.wallet === 'transfer') {
				if (!r.change) continue;
				const updated: any = await s.users.findOneAndUpdate({ _id : r.userId }, { $inc : { money : r.change } }, { new : true, session, projection : { money : 1 } }).lean();
				const after = round2(Number(updated.money) || 0);
				if (after !== updated.money) await s.users.updateOne({ _id : r.userId }, { $set : { money : after } }, { session });
				await s.transactions.create([{
					_id            : await s.nextId('transactions', session),
					user_id        : r.userId,
					vendor_id      : r.vendorId,
					type           : 'rollback',
					amount         : r.change,
					balance_before : round2(after - r.change),
					balance_after  : after,
					currency       : user.currency || vendor.currency || null,
					note, admin,
					request_id     : `rollback:${game}:${r.betId}`,
					game,
					table_id       : round.table_id,
					round_id       : round._id,
					round_num      : round.round_num,
					bet_id         : r.betId
				}], { session });
			} else {
				const actionId = `${game}:${r.betId}:rollback`;
				await s.vendorCalls.create([{
					_id       : actionId,
					vendor_id : r.vendorId,
					user_id   : r.userId,
					game      : API_GAME[game],
					type      : 'rollback',
					attempts  : 0,
					body      : {
						type : 'rollback', action_id : actionId, bet_id : bet?.bet_id || null,
						stake : r.stake, payout : r.paid, change : r.change,
						user_id : user.user_id, user_name : user.user_name,
						table : round.table_id, round_no : round.round_num,
						currency : user.currency || vendor.currency || null,
						vendor_id : r.vendorId, vendor_name : vendor.vendor_name, reason
					}
				}], { session });
			}
		}

		const mark = await removeMark(game, g, round, session);
		const newer = await g.rounds.exists({ table_id : round.table_id, status : 'E', _id : { $gt : round._id } }).session(session);
		return { round, rows, mark, latest : !newer };
	});

	const base = { gameName : GAME_LABELS[game], tableId : done.round.table_id, roundId : done.round._id, roundNum : done.round.round_num };
	const event = await voidEvent(game, g, done.round.table_id, done.mark, done.latest);
	const toRoadMap = event.eventName === 'displayRollback';
	const sent = await publishGameEvent({ ...base, ...event });

	const outcome: VoidResult = {
		roundNum : done.round.round_num,
		rows     : done.rows,
		mark     : done.mark ? 'removed' : 'not found',
		told     : !sent ? 'not sent' : toRoadMap ? 'road map' : 'notice'
	};
	// kept on the round: its page shows what the void did
	await g.rounds.updateOne({ _id : roundId }, { $set : { 'closed.mark' : outcome.mark, 'closed.told' : outcome.told } });
	return outcome;
}
