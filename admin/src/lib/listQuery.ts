/*
 |--------------------------------------------------------------------------
 | list queries
 |--------------------------------------------------------------------------
 | What every sortable, filterable, paged list reads from its search
 | params: a UTC date range, sort + direction, page and page size. Pure (no
 | database); the lists build on it in transactionQuery.ts and
 | activityQuery.ts.
 |
 | Dates are whole UTC days (the pages show UTC times): `to` includes that
 | day.
 |
 */

export type Params = Record<string, string | string[] | undefined>;

export const PAGE_SIZES = [25, 50, 100, 200];
export const DEFAULT_SIZE = 50;

export type Paging<S extends string> = {
	from : string;           // YYYY-MM-DD (UTC) or ''
	to   : string;
	sort : S;
	dir  : 'asc' | 'desc';
	page : number;
	size : number;
};

export const first = (value: string | string[] | undefined) => String((Array.isArray(value) ? value[0] : value) ?? '').trim();

/** one of `allowed`, else '' */
export const oneOf = <T extends string>(value: string, allowed: readonly T[]): T | '' =>
	(allowed as readonly string[]).includes(value) ? value as T : '';

/** a real calendar day as YYYY-MM-DD, else '' */
export function dayParam (value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value) ? value : '';
}

export function parsePaging<S extends string> (params: Params, sorts: readonly S[], defaultSort: S): Paging<S> {
	const page = Number(first(params.page));
	const size = Number(first(params.size));
	let from = dayParam(first(params.from));
	let to = dayParam(first(params.to));
	if (from && to && from > to) [from, to] = [to, from];

	return {
		from,
		to,
		sort : oneOf(first(params.sort), sorts) || defaultSort,
		dir  : first(params.dir) === 'asc' ? 'asc' : 'desc',
		page : Number.isInteger(page) && page > 0 ? page : 1,
		size : PAGE_SIZES.includes(size) ? size : DEFAULT_SIZE
	};
}

/** created_at condition of the date range, or null */
export function dateRange (query: { from : string; to : string }): Record<string, Date> | null {
	if (!query.from && !query.to) return null;
	const range: Record<string, Date> = {};
	if (query.from) range.$gte = new Date(`${query.from}T00:00:00Z`);
	if (query.to) range.$lt = new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000);
	return range;
}

/** `path` with the query as search params, leaving out the defaults */
export function queryHref (path: string, query: Record<string, unknown>, defaults: Record<string, string>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		const text = String(value ?? '');
		if (text && text !== defaults[key]) params.set(key, text);
	}
	const search = params.toString();
	return search ? `${path}?${search}` : path;
}

/** page numbers around the current one, null for a gap */
export function pageList (page: number, pages: number): (number | null)[] {
	const keep = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])]
		.filter(p => p >= 1 && p <= pages)
		.sort((a, b) => a - b);
	const out: (number | null)[] = [];
	keep.forEach((p, i) => {
		if (i && p - keep[i - 1] > 1) out.push(null);
		out.push(p);
	});
	return out;
}
