/*
 |--------------------------------------------------------------------------
 | sortable, paged lists
 |--------------------------------------------------------------------------
 | Column headers that sort and the page links under a list. Both build
 | their links with the list's own href function, so filters survive.
 |
 */

import Link from 'next/link';
import { pageList } from '@/lib/listQuery';

type Dir = 'asc' | 'desc';
type Href<S extends string> = (changes : { sort? : S; dir? : Dir; page? : number }) => string;

/** a header that sorts by `sort`; a second click flips the direction */
export function SortHeader<S extends string> ({ current, dir, sort, label, href, num = false, firstDir = 'desc' }: {
	current  : S;
	dir      : Dir;
	sort     : S;
	label    : string;
	href     : Href<S>;
	num?     : boolean;
	firstDir? : Dir;          // direction when the column is picked: newest / largest first unless said otherwise
}) {
	const active = current === sort;
	const next = active ? (dir === 'asc' ? 'desc' : 'asc') : firstDir;
	return (
		<th className={num ? 'num' : undefined} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
			<Link href={href({ sort, dir : next, page : 1 })} className={`sort${active ? ' on' : ''}`}>
				{label}{active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
			</Link>
		</th>
	);
}

/** "26–50 of 62  ← Prev 1 2 3 Next →" */
export function Pager ({ page, pages, size, total, shown, href }: {
	page  : number;
	pages : number;
	size  : number;
	total : number;
	shown : number;           // rows on this page
	href  : (page : number) => string;
}) {
	if (!total) return null;
	const from = (page - 1) * size + 1;
	return (
		<nav className="pager" aria-label="Pages">
			<span className="muted">{from.toLocaleString('en-US')}–{(from + shown - 1).toLocaleString('en-US')} of {total.toLocaleString('en-US')}</span>
			{pages > 1 && (
				<span className="pages">
					{page > 1 ? <Link href={href(page - 1)}>← Prev</Link> : <span className="muted">← Prev</span>}
					{pageList(page, pages).map((p, i) => p === null
						? <span key={`gap${i}`} className="muted">…</span>
						: p === page
							? <strong key={p} aria-current="page">{p}</strong>
							: <Link key={p} href={href(p)}>{p}</Link>)}
					{page < pages ? <Link href={href(page + 1)}>Next →</Link> : <span className="muted">Next →</span>}
				</span>
			)}
		</nav>
	);
}
