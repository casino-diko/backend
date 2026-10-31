/*
 |--------------------------------------------------------------------------
 | player transactions: query
 |--------------------------------------------------------------------------
 | The search params of the transactions list on /users/{id}, parsed and
 | written back. Pure (no database), covered by test/activityQuery.test.ts.
 |
 |   what    : all | credits (adjustments) | bets (every game) | one game
 |   outcome : gain (change > 0) | loss (< 0) | open (bets of unresulted rounds)
 |
 */

import { GAMES, type Game } from './config.ts';
import { DEFAULT_SIZE, first, oneOf, parsePaging, queryHref, type Paging, type Params } from './listQuery.ts';

export { PAGE_SIZES } from './listQuery.ts';

export const SORTS = ['time', 'stake', 'payout', 'change'] as const;
export type Sort = typeof SORTS[number];

export const WHATS = ['credits', 'bets', ...GAMES] as const;
export type What = '' | typeof WHATS[number];

export const OUTCOMES = ['gain', 'loss', 'open'] as const;
export type Outcome = '' | typeof OUTCOMES[number];

export type ActivityQuery = Paging<Sort> & {
	what    : What;
	outcome : Outcome;
};

const DEFAULTS = { sort : 'time', dir : 'desc', page : '1', size : String(DEFAULT_SIZE) };

export function parseActivityQuery (params: Params): ActivityQuery {
	// links from before the filters had ?show=credits / ?show=bets
	const what = oneOf(first(params.what) || first(params.show), WHATS);
	const paging = parsePaging(params, SORTS, 'time');
	return {
		what,
		outcome : oneOf(first(params.outcome), OUTCOMES),
		from    : paging.from,
		to      : paging.to,
		sort    : paging.sort,
		dir     : paging.dir,
		page    : paging.page,
		size    : paging.size
	};
}

export function activityHref (userId: number, query: ActivityQuery, changes: Partial<ActivityQuery> = {}): string {
	return queryHref(`/users/${userId}`, { ...query, ...changes }, DEFAULTS);
}

/** the sources a query reads: the credit adjustments and/or game bet collections */
export function activitySources (query: Pick<ActivityQuery, 'what' | 'outcome'>): { credits : boolean; games : Game[] } {
	const { what, outcome } = query;
	return {
		// adjustments are never open
		credits : (what === '' || what === 'credits') && outcome !== 'open',
		games   : what === '' || what === 'bets' ? [...GAMES] : GAMES.filter(g => g === what)
	};
}

export type Row = { sortValue : number | null; at : number; source : string; id : number };

/**
 * The order of the merged list. Each source is sorted the same way by
 * MongoDB (value, created_at, _id), so the first N rows of the merge are
 * within the first N rows of every source. A missing value (stake / payout
 * of an adjustment, payout of an open bet) sorts like MongoDB's null: below
 * every number.
 */
export function compareRows (a: Row, b: Row, dir: 'asc' | 'desc'): number {
	const sign = dir === 'asc' ? 1 : -1;
	const value = (v: number | null) => (v === null ? -Infinity : v);
	if (value(a.sortValue) !== value(b.sortValue)) return (value(a.sortValue) < value(b.sortValue) ? -1 : 1) * sign;
	if (a.at !== b.at) return (a.at < b.at ? -1 : 1) * sign;
	if (a.source !== b.source) return a.source < b.source ? -1 : 1;
	return (a.id - b.id) * sign;
}
