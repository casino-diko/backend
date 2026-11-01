/*
 |--------------------------------------------------------------------------
 | transactions list: query
 |--------------------------------------------------------------------------
 | The search params of /transactions, parsed and written back. Pure (no
 | database), covered by test/transactionQuery.test.ts.
 |
 */

import { DEFAULT_SIZE, first, oneOf, parsePaging, queryHref, type Paging, type Params } from './listQuery.ts';

export { dayParam, PAGE_SIZES } from './listQuery.ts';

export const SORTS = ['time', 'change', 'balance', 'admin'] as const;
export type Sort = typeof SORTS[number];

export const TYPES = ['credit', 'debit', 'refund', 'rollback'] as const;

export type ListQuery = Paging<Sort> & {
	q     : string;          // player: login id, name or #id
	type  : '' | typeof TYPES[number];
	admin : string;
};

const DEFAULTS = { sort : 'time', dir : 'desc', page : '1', size : String(DEFAULT_SIZE) };

export function parseListQuery (params: Params): ListQuery {
	const paging = parsePaging(params, SORTS, 'time');
	return {
		q     : first(params.q).slice(0, 100),
		type  : oneOf(first(params.type), TYPES),
		admin : first(params.admin).slice(0, 100),
		from  : paging.from,
		to    : paging.to,
		sort  : paging.sort,
		dir   : paging.dir,
		page  : paging.page,
		size  : paging.size
	};
}

/** the query as search params, leaving out defaults; `changes` override fields */
export function listHref (query: ListQuery, changes: Partial<ListQuery> = {}): string {
	return queryHref('/transactions', { ...query, ...changes }, DEFAULTS);
}
