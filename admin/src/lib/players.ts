/*
 |--------------------------------------------------------------------------
 | players
 |--------------------------------------------------------------------------
 | Creating players, credit adjustments and the activity of a player.
 |
 | Money only lives in users.money for vendors with integration_type
 | 'transfer'; seamless vendors hold the balance in their own wallet API, so
 | their players can be created but not credited here.
 |
 | An adjustment runs in one MongoDB transaction: users.money $inc (guarded by
 | the balance for debits) + the `transactions` document. Game bets and
 | settlement change users.money in their own transactions, so they conflict
 | with ours and retry instead of losing an update.
 |
 */

import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import type { ClientSession } from 'mongoose';
import { GAMES, GAME_LABELS, type Game } from './config';
import { getDb, type Db } from './db';
import { Invalid, addMoney, type NewUser } from './validate';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const isTransfer = (vendor: any) => !!vendor && vendor.integration_type !== 'seamless';

/** scrypt$<salt hex>$<hash hex>; the player front-end has no password login yet */
async function hashPassword (password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scrypt(password, salt, 64);
	return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const isDuplicateKey = (e: any) => e && (e.code === 11000 || e.codeName === 'DuplicateKey');

type Adjustment = {
	userId    : number;
	type      : 'credit' | 'debit';
	amount    : number;
	note      : string;
	admin     : string;
	requestId : string;
};

/** inside an open transaction; returns the new balance */
async function applyAdjustment (db: Db, session: ClientSession, a: Adjustment): Promise<number> {
	const { users, vendors, transactions } = db.shared;

	const user: any = await users.findOne({ _id : a.userId, deleted_at : null }).session(session).lean();
	if (!user) throw new Invalid('Player not found');

	const vendor: any = await vendors.findById(user.vendor_id).session(session).lean();
	if (!isTransfer(vendor)) throw new Invalid('This player\'s vendor uses a seamless wallet; its balance is managed by the vendor');

	const delta = a.type === 'credit' ? a.amount : -a.amount;
	const filter: any = { _id : a.userId };
	if (delta < 0) filter.money = { $gte : a.amount };

	const updated: any = await users.findOneAndUpdate(filter, { $inc : { money : delta } }, { new : true, session }).lean();
	if (!updated) throw new Invalid(`Insufficient balance: the player has ${Number(user.money) || 0}`);

	// $inc on a float can drift (0.1 + 0.2); store the rounded balance
	const after = addMoney(Number(updated.money) || 0, 0);
	if (after !== updated.money) await users.updateOne({ _id : a.userId }, { $set : { money : after } }, { session });

	await transactions.create([{
		_id            : await db.shared.nextId('transactions', session),
		user_id        : a.userId,
		vendor_id      : user.vendor_id,
		type           : a.type,
		amount         : a.amount,
		balance_before : addMoney(after, -delta),
		balance_after  : after,
		currency       : user.currency || vendor.currency || null,
		note           : a.note || null,
		admin          : a.admin,
		request_id     : a.requestId || null
	}], { session });

	return after;
}

/** credits or debits a player; a request_id seen before is a no-op (double submit) */
export async function adjustCredits (a: Adjustment): Promise<{ balance : number; duplicate : boolean }> {
	const db = await getDb();
	try {
		const balance = await db.withTransaction(session => applyAdjustment(db, session, a));
		return { balance, duplicate : false };
	} catch (e) {
		if (!isDuplicateKey(e)) throw e;
		const user: any = await db.shared.users.findById(a.userId, { money : 1 }).lean();
		return { balance : Number(user?.money) || 0, duplicate : true };
	}
}

/** creates the player (and the initial credit transaction); returns the new users._id */
export async function createUser (input: NewUser, admin: string, requestId: string): Promise<number> {
	const db = await getDb();
	const { users, vendors } = db.shared;
	const password = input.password ? await hashPassword(input.password) : null;

	try {
		return await db.withTransaction(async session => {
			const vendor: any = await vendors.findById(input.vendor_id).session(session).lean();
			if (!vendor) throw new Invalid('Vendor not found');
			if (input.initial_credit && !isTransfer(vendor)) {
				throw new Invalid('Seamless wallet vendors hold the balance themselves: leave the initial credit empty');
			}

			const taken = await users.exists({ vendor_id : input.vendor_id, user_id : input.user_id, deleted_at : null }).session(session);
			if (taken) throw new Invalid(`The login id "${input.user_id}" is already used for this vendor`);

			const id = await db.shared.nextId('users', session);
			await users.create([{
				_id          : id,
				vendor_id    : input.vendor_id,
				user_id      : input.user_id,
				user_name    : input.user_name,
				password,
				money        : 0,
				currency     : input.currency || vendor.currency || null,
				user_type    : input.user_type,
				denomination : 1,
				is_active    : '1',
				is_online    : '0',
				created_by   : admin
			}], { session });

			if (input.initial_credit) {
				await applyAdjustment(db, session, {
					userId : id, type : 'credit', amount : input.initial_credit,
					note : input.note || 'initial credit', admin, requestId
				});
			}
			return id;
		});
	} catch (e) {
		if (isDuplicateKey(e)) throw new Invalid('This form was already submitted');
		throw e;
	}
}

// ------------------------------------------------------------------ activity

export type Activity = {
	key      : string;
	at       : Date;
	kind     : 'credit' | 'debit' | 'bet';
	label    : string;
	detail   : string;
	amount   : number;         // signed change of the balance (bets: payout - stake, once resulted)
	stake?   : number;
	payout?  : number;
	pending? : boolean;
	balance? : number | null;  // after the adjustment (admin transactions only)
	by?      : string | null;
};

const ROUND_STATUS: Record<string, string> = { S : 'betting', P : 'dealing', H : 'on hold', E : 'resulted' };

async function gameBets (db: Db, game: Game, userId: number, limit: number): Promise<Activity[]> {
	const g = db.games[game];
	const bets: any[] = await g.bets.find({ user_id : userId }).sort({ _id : -1 }).limit(limit).lean();
	if (!bets.length) return [];

	const rounds: any[] = await g.rounds.find({ _id : { $in : bets.map(b => b.round_id) } }, { table_id : 1, round_num : 1, status : 1 }).lean();
	const byId = new Map(rounds.map(r => [r._id, r]));

	return bets.map(b => {
		const round = byId.get(b.round_id);
		const stake = Number(b.total_bet) || 0;
		const resulted = round?.status === 'E';
		const payout = resulted ? Number(b.total_win) || 0 : 0;
		return {
			key     : `${game}-${b._id}`,
			at      : b.created_at,
			kind    : 'bet',
			label   : `${GAME_LABELS[game]} bet`,
			detail  : round
				? `table ${round.table_id ?? b.table_id ?? '?'} · round ${round.round_num ?? b.round_num ?? '?'} · ${ROUND_STATUS[round.status] || round.status}`
				: `round ${b.round_id}`,
			amount  : resulted ? addMoney(payout, -stake) : -stake,
			stake,
			payout  : resulted ? payout : undefined,
			pending : !resulted
		} satisfies Activity;
	});
}

/** the latest `limit` adjustments and bets of a player, newest first */
export async function userActivity (userId: number, limit: number, kinds: { credits : boolean; bets : boolean }): Promise<Activity[]> {
	const db = await getDb();

	const sources: Promise<Activity[]>[] = [];
	if (kinds.credits) {
		sources.push(db.shared.transactions.find({ user_id : userId }).sort({ _id : -1 }).limit(limit).lean().then((rows: any[]) => rows.map((t): Activity => ({
			key     : `tx-${t._id}`,
			at      : t.created_at,
			kind    : t.type,
			label   : t.type === 'credit' ? 'Credit added' : 'Credit deducted',
			detail  : t.note || '',
			amount  : t.type === 'credit' ? t.amount : -t.amount,
			balance : t.balance_after ?? null,
			by      : t.admin || null
		}))));
	}
	if (kinds.bets) {
		for (const game of GAMES) sources.push(gameBets(db, game, userId, limit));
	}

	// every source is newest first, so the newest `limit` of the union are within the first `limit` of each
	const all = (await Promise.all(sources)).flat();
	all.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
	return all.slice(0, limit);
}
