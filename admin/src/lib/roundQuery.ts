/*
 |--------------------------------------------------------------------------
 | rounds list: query
 |--------------------------------------------------------------------------
 | The search params of /rounds, parsed and written back. Pure (no
 | database), covered by test/roundQuery.test.ts.
 |
 |   game    : '' (all) | baccarat | dragontiger | poker
 |   status  : '' (all) | E successful | C cancelled | V voided | open (S / P / H)
 |   table, dealer, round : numbers, or null
 |
 */

import { GAMES, type Game } from './config.ts';
import { DEFAULT_SIZE, first, oneOf, parsePaging, queryHref, type Paging, type Params } from './listQuery.ts';

export { PAGE_SIZES } from './listQuery.ts';

export const SORTS = ['time', 'round', 'players', 'bets', 'payout', 'net', 'refunded'] as const;
export type Sort = typeof SORTS[number];

export const STATUSES = ['E', 'C', 'V', 'open'] as const;
export type StatusFilter = '' | typeof STATUSES[number];

export type RoundQuery = Paging<Sort> & {
	game   : '' | Game;
	status : StatusFilter;
	table  : number | null;
	dealer : number | null;
	round  : number | null;
};

const DEFAULTS = { sort : 'time', dir : 'desc', page : '1', size : String(DEFAULT_SIZE) };

const id = (value: string): number | null => {
	const n = Number(value.replace(/^#/, ''));
	return value !== '' && Number.isInteger(n) && n > 0 ? n : null;
};

export function parseRoundQuery (params: Params): RoundQuery {
	const paging = parsePaging(params, SORTS, 'time');
	return {
		game   : oneOf(first(params.game), GAMES),
		status : oneOf(first(params.status), STATUSES),
		table  : id(first(params.table)),
		dealer : id(first(params.dealer)),
		round  : id(first(params.round)),
		from   : paging.from,
		to     : paging.to,
		sort   : paging.sort,
		dir    : paging.dir,
		page   : paging.page,
		size   : paging.size
	};
}

export function roundsHref (query: RoundQuery, changes: Partial<RoundQuery> = {}): string {
	return queryHref('/rounds', { ...query, ...changes }, DEFAULTS);
}

/** the games a query reads */
export const roundGames = (query: Pick<RoundQuery, 'game'>): Game[] => query.game ? [query.game] : [...GAMES];

/** MongoDB condition on rounds.status, or null for every status */
export function statusMatch (status: StatusFilter): string | { $in : string[] } | null {
	if (!status) return null;
	return status === 'open' ? { $in : ['S', 'P', 'H'] } : status;
}
