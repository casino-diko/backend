/*
 |--------------------------------------------------------------------------
 | transactions list
 |--------------------------------------------------------------------------
 | Filters, sorts and pages the credit adjustments (`transactions`) for a
 | query from transactionQuery.ts. Sorting by time uses _id, which grows
 | with created_at; every other sort falls back to _id so equal values keep
 | a stable order across pages.
 |
 */

import { getDb } from './db';
import { escapeRegex } from './format';
import { dateRange } from './listQuery';
import type { ListQuery, Sort } from './transactionQuery';

const SORT_FIELDS: Record<Sort, string> = { time : '_id', change : 'change', balance : 'balance_after', admin : 'admin' };

// signed amount: credits positive, debits negative
const CHANGE = { $cond : [{ $eq : ['$type', 'credit'] }, '$amount', { $multiply : ['$amount', -1] }] };

export type ListResult = {
	rows   : any[];
	users  : Map<number, any>;
	admins : string[];
	total  : number;
	pages  : number;
	page   : number;           // clamped to the last page
	credit : number;           // sums over the whole filtered result
	debit  : number;
};

export async function listTransactions (query: ListQuery): Promise<ListResult> {
	const db = await getDb();
	const { transactions, users } = db.shared;

	const match: any = {};
	if (query.type) match.type = query.type;
	if (query.admin) match.admin = query.admin;
	const created = dateRange(query);
	if (created) match.created_at = created;

	const admins: string[] = (await transactions.distinct('admin')).filter(Boolean).sort();
	const empty = { rows : [], users : new Map(), admins, total : 0, pages : 1, page : 1, credit : 0, debit : 0 };

	if (query.q) {
		const rx = new RegExp(escapeRegex(query.q), 'i');
		const or: any[] = [{ user_id : rx }, { user_name : rx }];
		if (/^#?\d+$/.test(query.q)) or.push({ _id : Number(query.q.replace('#', '')) });
		const ids = (await users.find({ $or : or }, { _id : 1 }).limit(1000).lean()).map((u: any) => u._id);
		if (!ids.length) return empty;
		match.user_id = { $in : ids };
	}

	const [meta] = await transactions.aggregate([
		{ $match : match },
		{ $group : {
			_id    : null,
			total  : { $sum : 1 },
			credit : { $sum : { $cond : [{ $eq : ['$type', 'credit'] }, '$amount', 0] } },
			debit  : { $sum : { $cond : [{ $eq : ['$type', 'debit'] }, '$amount', 0] } }
		} }
	]);
	if (!meta) return empty;

	const pages = Math.max(1, Math.ceil(meta.total / query.size));
	const page = Math.min(query.page, pages);
	const dir = query.dir === 'asc' ? 1 : -1;
	const field = SORT_FIELDS[query.sort];
	const sort: Record<string, 1 | -1> = field === '_id' ? { _id : dir } : { [field] : dir, _id : dir };

	const rows: any[] = await transactions.aggregate([
		{ $match : match },
		{ $addFields : { change : CHANGE } },
		{ $sort : sort },
		{ $skip : (page - 1) * query.size },
		{ $limit : query.size }
	]);

	const found: any[] = await users.find({ _id : { $in : [...new Set(rows.map(r => r.user_id))] } }, { user_id : 1, user_name : 1 }).lean();

	return {
		rows,
		users  : new Map(found.map(u => [u._id, u])),
		admins,
		total  : meta.total,
		pages,
		page,
		credit : meta.credit,
		debit  : meta.debit
	};
}
