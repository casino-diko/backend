import Link from 'next/link';
import { getDb } from '@/lib/db';
import { dateTime, escapeRegex, intParam, money, signed, strParam } from '@/lib/format';
import { requireAdmin } from '@/lib/session';

const PAGE_SIZE = 100;

type Props = { searchParams : Promise<Record<string, string | string[] | undefined>> };

/** every credit adjustment, newest first; paged by _id so new rows don't shift the pages */
export default async function TransactionsPage ({ searchParams }: Props) {
	await requireAdmin();
	const params = await searchParams;
	const q = strParam(params.q);
	const type = ['credit', 'debit'].includes(strParam(params.type)) ? strParam(params.type) : '';
	const before = intParam(params.before, 0);

	const db = await getDb();
	const filter: any = {};
	if (type) filter.type = type;
	if (before) filter._id = { $lt : before };

	let noMatch = false;
	if (q) {
		const rx = new RegExp(escapeRegex(q), 'i');
		const or: any[] = [{ user_id : rx }, { user_name : rx }];
		if (/^\d+$/.test(q)) or.push({ _id : Number(q) });
		const ids = (await db.shared.users.find({ $or : or }, { _id : 1 }).limit(500).lean()).map((u: any) => u._id);
		filter.user_id = { $in : ids };
		noMatch = !ids.length;
	}

	const rows: any[] = noMatch ? [] : await db.shared.transactions.find(filter).sort({ _id : -1 }).limit(PAGE_SIZE).lean();
	const users: any[] = await db.shared.users.find({ _id : { $in : [...new Set(rows.map(r => r.user_id))] } }, { user_id : 1, user_name : 1 }).lean();
	const userById = new Map(users.map(u => [u._id, u]));

	const totals = rows.reduce((t, r) => (t[r.type as 'credit' | 'debit'] += r.amount, t), { credit : 0, debit : 0 });
	const next = rows.length === PAGE_SIZE ? `/transactions?${new URLSearchParams({ ...(q && { q }), ...(type && { type }), before : String(rows[rows.length - 1]._id) })}` : null;

	return (
		<>
			<h1>Credit transactions</h1>
			<form className="panel row" method="get">
				<label>Player<input name="q" defaultValue={q} placeholder="login id, name or #id" /></label>
				<label>Type
					<select name="type" defaultValue={type}>
						<option value="">all</option>
						<option value="credit">added</option>
						<option value="debit">deducted</option>
					</select>
				</label>
				<button type="submit" className="secondary">Filter</button>
				{(q || type || before) ? <Link href="/transactions">Reset</Link> : null}
			</form>

			<div className="panel scroll">
				<p className="muted">
					This page: <span className="pos">{signed(totals.credit)}</span> added, <span className="neg">{signed(-totals.debit)}</span> deducted.
					Game bets of a player are on the player&apos;s page.
				</p>
				<table>
					<thead>
						<tr><th>#</th><th>Time (UTC)</th><th>Player</th><th className="num">Change</th><th className="num">Balance after</th><th>Note</th><th>By</th></tr>
					</thead>
					<tbody>
						{rows.map(r => {
							const u = userById.get(r.user_id);
							const amount = r.type === 'credit' ? r.amount : -r.amount;
							return (
								<tr key={r._id}>
									<td>{r._id}</td>
									<td className="muted">{dateTime(r.created_at)}</td>
									<td><Link href={`/users/${r.user_id}`}>{u ? `${u.user_id} · ${u.user_name}` : `#${r.user_id}`}</Link></td>
									<td className={`num ${amount > 0 ? 'pos' : 'neg'}`}>{signed(amount)} <span className="muted">{r.currency}</span></td>
									<td className="num">{money(r.balance_after)}</td>
									<td>{r.note}</td>
									<td className="muted">{r.admin}</td>
								</tr>
							);
						})}
						{!rows.length && <tr><td colSpan={7} className="muted">No transactions.</td></tr>}
					</tbody>
				</table>
				{next && <div className="pager"><Link href={next}>Older →</Link></div>}
			</div>
		</>
	);
}
