import Link from 'next/link';
import { Pager, SortHeader } from '../list';
import { dateTime, money, signed } from '@/lib/format';
import { requireAdmin } from '@/lib/session';
import { PAGE_SIZES, listHref, parseListQuery, type Sort } from '@/lib/transactionQuery';
import { listTransactions } from '@/lib/transactions';

type Props = { searchParams : Promise<Record<string, string | string[] | undefined>> };

export default async function TransactionsPage ({ searchParams }: Props) {
	await requireAdmin();
	const query = parseListQuery(await searchParams);
	const result = await listTransactions(query);
	const shown = { ...query, page : result.page };
	const filtered = !!(query.q || query.type || query.admin || query.from || query.to);
	const href = (changes: { sort? : Sort; dir? : 'asc' | 'desc'; page? : number }) => listHref(shown, changes);

	return (
		<>
			<h1>Credit transactions</h1>
			<form className="panel row" method="get">
				<label>Player<input name="q" defaultValue={query.q} placeholder="login id, name or #id" /></label>
				<label>Type
					<select name="type" defaultValue={query.type}>
						<option value="">all</option>
						<option value="credit">added</option>
						<option value="debit">deducted</option>
					</select>
				</label>
				<label>By
					<select name="admin" defaultValue={query.admin}>
						<option value="">anyone</option>
						{result.admins.map(a => <option key={a} value={a}>{a}</option>)}
					</select>
				</label>
				<label>From (UTC)<input type="date" name="from" defaultValue={query.from} /></label>
				<label>To<input type="date" name="to" defaultValue={query.to} /></label>
				<label>Per page
					<select name="size" defaultValue={query.size}>
						{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
					</select>
				</label>
				{/* keep the sort order when filtering */}
				<input type="hidden" name="sort" value={query.sort} />
				<input type="hidden" name="dir" value={query.dir} />
				<button type="submit" className="secondary">Filter</button>
				{filtered && <Link href={listHref({ ...query, q : '', type : '', admin : '', from : '', to : '', page : 1 })}>Reset</Link>}
			</form>

			<div className="panel scroll">
				<p className="muted">
					{result.total.toLocaleString('en-US')} transaction{result.total === 1 ? '' : 's'}{filtered ? ' match' : ''}:{' '}
					<span className="pos">{signed(result.credit)}</span> added, <span className="neg">{signed(-result.debit)}</span> deducted.
					Game bets of a player are on the player&apos;s page.
				</p>
				<table>
					<thead>
						<tr>
							<th>#</th>
							<SortHeader current={query.sort} dir={query.dir} href={href} sort="time" label="Time (UTC)" />
							<th>Player</th>
							<SortHeader current={query.sort} dir={query.dir} href={href} sort="change" label="Change" num />
							<SortHeader current={query.sort} dir={query.dir} href={href} sort="balance" label="Balance after" num />
							<th>Note</th>
							<SortHeader current={query.sort} dir={query.dir} href={href} sort="admin" label="By" firstDir="asc" />
						</tr>
					</thead>
					<tbody>
						{result.rows.map(r => {
							const u = result.users.get(r.user_id);
							return (
								<tr key={r._id}>
									<td>{r._id}</td>
									<td className="muted">{dateTime(r.created_at)}</td>
									<td><Link href={`/users/${r.user_id}`}>{u ? `${u.user_id} · ${u.user_name}` : `#${r.user_id}`}</Link></td>
									<td className={`num ${r.change > 0 ? 'pos' : 'neg'}`}>{signed(r.change)} <span className="muted">{r.currency}</span></td>
									<td className="num">{money(r.balance_after)}</td>
									<td>{r.note}</td>
									<td className="muted">{r.admin}</td>
								</tr>
							);
						})}
						{!result.rows.length && <tr><td colSpan={7} className="muted">No transactions{filtered ? ' match these filters' : ''}.</td></tr>}
					</tbody>
				</table>

				<Pager page={result.page} pages={result.pages} size={query.size} total={result.total} shown={result.rows.length} href={page => href({ page })} />
			</div>
		</>
	);
}
