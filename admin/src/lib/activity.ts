/*
 |--------------------------------------------------------------------------
 | player transactions
 |--------------------------------------------------------------------------
 | One list of a player's credit adjustments (shared `transactions`) and
 | bets (`bets` of every game database, with the round's status). They live
 | in different databases, so every source filters and sorts itself in
 | MongoDB and returns only its first page × size rows; the merge of those
 | (compareRows) holds the requested page exactly. Counts and sums come
 | from each source in full.
 |
 | A bet counts once its round is resulted (status E): change = payout -
 | stake. Before that it is open: change = -stake, no payout. A cancelled
 | round's bet (C) stays at -stake: the game-server's `refund` transaction
 | gives it back. A voided round's bet (V) keeps what was paid (payout -
 | stake): the admin's signed `rollback` transaction undoes it. So the rows
 | always add up to the balance changes.
 |
 */

import { GAME_LABELS, type Game } from './config';
import { getDb } from './db';
import { dateRange } from './listQuery';
import { CHANGE } from './transactions';
import { activitySources, compareRows, type ActivityQuery, type Sort } from './activityQuery';

export type Activity = {
	key      : string;
	at       : Date;
	kind     : 'credit' | 'debit' | 'refund' | 'rollback' | 'bet';
	label    : string;
	detail   : string;
	stake    : number | null;
	payout   : number | null;
	change   : number;
	open     : boolean;
	balance  : number | null;  // after the adjustment (adjustments only)
	by       : string | null;
};

export type ActivityResult = {
	rows   : Activity[];
	total  : number;
	pages  : number;
	page   : number;           // clamped to the last page
	stake  : number;           // sums over the whole filtered result
	payout : number;
	change : number;
};

const SORT_FIELDS: Record<Sort, string> = { time : 'created_at', stake : 'stake', payout : 'payout', change : 'change' };

const ROUND_STATUS: Record<string, string> = { S : 'betting', P : 'dealing', H : 'on hold', E : 'resulted', C : 'cancelled', V : 'voided' };

const TX_LABELS: Record<string, string> = {
	credit   : 'Credit added',
	debit    : 'Credit deducted',
	refund   : 'Refund: round cancelled',
	rollback : 'Rollback: round voided'
};

const num = (path: string) => ({ $convert : { input : path, to : 'double', onError : 0, onNull : 0 } });

type Source = {
	name : string;
	run  : (stages : any[]) => Promise<any[]>;
	base : any[];                     // filter + computed stake / payout / change
	map  : (doc : any) => Activity;
};

function creditSource (db: Awaited<ReturnType<typeof getDb>>, userId: number, query: ActivityQuery): Source {
	const match: any = { user_id : userId };
	const created = dateRange(query);
	if (created) match.created_at = created;

	return {
		name : 'credits',
		run  : stages => db.shared.transactions.aggregate(stages),
		base : [
			{ $match : match },
			{ $set : { stake : null, payout : null, change : CHANGE } },
			...(query.outcome === 'gain' ? [{ $match : { change : { $gt : 0 } } }]
				: query.outcome === 'loss' ? [{ $match : { change : { $lt : 0 } } }]
				: [])
		],
		map  : t => ({
			key     : `tx-${t._id}`,
			at      : t.created_at,
			kind    : t.type,
			label   : TX_LABELS[t.type] || t.type,
			detail  : t.note || '',
			stake   : null,
			payout  : null,
			change  : t.change,
			open    : false,
			balance : t.balance_after ?? null,
			by      : t.admin || null
		})
	};
}

function betSource (db: Awaited<ReturnType<typeof getDb>>, game: Game, userId: number, query: ActivityQuery): Source {
	const match: any = { user_id : userId };
	const created = dateRange(query);
	if (created) match.created_at = created;

	const outcome: any = query.outcome === 'gain' ? { change : { $gt : 0 } }
		: query.outcome === 'loss' ? { change : { $lt : 0 } }
		: query.outcome === 'open' ? { open : true }
		: null;

	return {
		name : game,
		run  : stages => db.games[game].bets.aggregate(stages),
		base : [
			{ $match : match },
			{ $lookup : { from : 'rounds', localField : 'round_id', foreignField : '_id', as : 'round', pipeline : [{ $project : { status : 1, table_id : 1, round_num : 1 } }] } },
			{ $set : { round : { $first : '$round' }, stake : num('$total_bet') } },
			{ $set : { open : { $not : [{ $in : ['$round.status', ['E', 'C', 'V']] }] } } },
			// paid at settlement: E total_win, V what was paid before the void; a cancelled round paid nothing
			{ $set : { paid : { $switch : { branches : [
				{ case : { $eq : ['$round.status', 'E'] }, then : num('$total_win') },
				{ case : { $eq : ['$round.status', 'V'] }, then : num('$reversed') },
				{ case : { $eq : ['$round.status', 'C'] }, then : 0 }
			], default : null } } } },
			{ $set : {
				payout : '$paid',
				change : { $subtract : [{ $ifNull : ['$paid', 0] }, '$stake'] }
			} },
			...(outcome ? [{ $match : outcome }] : [])
		],
		map  : b => ({
			key     : `${game}-${b._id}`,
			at      : b.created_at,
			kind    : 'bet',
			label   : `${GAME_LABELS[game]} bet`,
			detail  : b.round
				? `table ${b.round.table_id ?? b.table_id ?? '?'} · round ${b.round.round_num ?? b.round_num ?? '?'} · ${ROUND_STATUS[b.round.status] || b.round.status}`
				: `round ${b.round_id}`,
			stake   : b.stake,
			payout  : b.payout,
			change  : b.change,
			open    : b.open,
			balance : null,
			by      : null
		})
	};
}

export async function listActivity (userId: number, query: ActivityQuery): Promise<ActivityResult> {
	const db = await getDb();
	const { credits, games } = activitySources(query);
	const sources = [
		...(credits ? [creditSource(db, userId, query)] : []),
		...games.map(game => betSource(db, game, userId, query))
	];

	const metas = await Promise.all(sources.map(s => s.run([
		...s.base,
		{ $group : { _id : null, total : { $sum : 1 }, stake : { $sum : '$stake' }, payout : { $sum : '$payout' }, change : { $sum : '$change' } } }
	])));
	const sum = (key: 'total' | 'stake' | 'payout' | 'change') =>
		Math.round(metas.reduce((t, [m]) => t + (m ? m[key] || 0 : 0), 0) * 100) / 100;

	const total = sum('total');
	const pages = Math.max(1, Math.ceil(total / query.size));
	const page = Math.min(query.page, pages);
	const result = { rows : [] as Activity[], total, pages, page, stake : sum('stake'), payout : sum('payout'), change : sum('change') };
	if (!total) return result;

	const dir = query.dir === 'asc' ? 1 : -1;
	const field = SORT_FIELDS[query.sort];
	const sort: Record<string, 1 | -1> = field === 'created_at' ? { created_at : dir, _id : dir } : { [field] : dir, created_at : dir, _id : dir };
	const need = page * query.size;

	const lists = await Promise.all(sources.map(async s => (await s.run([...s.base, { $sort : sort }, { $limit : need }]))
		.map(doc => ({ row : s.map(doc), order : { sortValue : field === 'created_at' ? null : doc[field] ?? null, at : new Date(doc.created_at).getTime() || 0, source : s.name, id : doc._id } }))));

	result.rows = lists.flat()
		.sort((a, b) => compareRows(a.order, b.order, query.dir))
		.slice((page - 1) * query.size, need)
		.map(x => x.row);
	return result;
}
