import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreditForm, PasswordForm } from '../../forms';
import { Pager, SortHeader } from '../../list';
import { listActivity } from '@/lib/activity';
import { PAGE_SIZES, activityHref, parseActivityQuery, type ActivityQuery, type Sort } from '@/lib/activityQuery';
import { GAMES, GAME_LABELS } from '@/lib/config';
import { getDb } from '@/lib/db';
import { dateTime, money, signed } from '@/lib/format';
import { unlockAction } from '@/lib/actions';
import { isTransfer } from '@/lib/players';
import { requireAdmin } from '@/lib/session';

type Props = {
	params       : Promise<{ id : string }>;
	searchParams : Promise<Record<string, string | string[] | undefined>>;
};

const OUTCOME_LABELS = { gain : 'gains (change > 0)', loss : 'losses (change < 0)', open : 'open bets' };

export default async function UserPage ({ params, searchParams }: Props) {
	await requireAdmin();
	const id = Number((await params).id);
	if (!Number.isInteger(id)) notFound();
	const search = await searchParams;
	const query = parseActivityQuery(search);

	const db = await getDb();
	const user: any = await db.shared.users.findOne({ _id : id, deleted_at : null }).lean();
	if (!user) notFound();
	const vendor: any = await db.shared.vendors.findById(user.vendor_id).lean();
	const transfer = isTransfer(vendor);
	const currency = user.currency || vendor?.currency || '';
	const lockedUntil = user.locked_until && new Date(user.locked_until) > new Date() ? new Date(user.locked_until) : null;
	const hasPassword = typeof user.password === 'string' && user.password.startsWith('scrypt$');

	const result = await listActivity(id, query);
	const shown: ActivityQuery = { ...query, page : result.page };
	const filtered = !!(query.what || query.outcome || query.from || query.to);
	// links land on the list, not on the top of the page
	const href = (changes: Partial<ActivityQuery>) => `${activityHref(id, shown, changes)}#transactions`;
	const header = { current : query.sort, dir : query.dir, href : (c: { sort? : Sort; dir? : 'asc' | 'desc'; page? : number }) => href(c) };

	return (
		<>
			<p><Link href="/">← Players</Link></p>
			{search.created && <p className="ok">Player created.</p>}
			<h1>{user.user_name} <span className="muted">· {user.user_id} · #{user._id}</span></h1>

			<div className="grid">
				<div className="panel">
					<h2>Balance</h2>
					{transfer
						? <div className="stat">{money(user.money)} <span className="muted">{currency}</span></div>
						: <p className="note">Seamless wallet: the balance is held by the vendor&apos;s API, not here.</p>}
					<table>
						<tbody>
							<tr><th>Vendor</th><td>{vendor?.vendor_name ?? user.vendor_id} <span className="badge">{transfer ? 'transfer' : 'seamless'}</span></td></tr>
							<tr><th>Type</th><td>{user.user_type || '—'}</td></tr>
							<tr><th>Status</th><td>{user.is_active === '0' ? 'inactive' : 'active'}{user.is_online === '1' && ' · online'}</td></tr>
							<tr><th>Created</th><td>{dateTime(user.created_at)}{user.created_by && <span className="muted"> by {user.created_by}</span>}</td></tr>
						</tbody>
					</table>
				</div>

				{transfer && (
					<div className="panel">
						<h2>Credits</h2>
						<CreditForm userId={id} requestId={randomUUID()} />
					</div>
				)}

				<div className="panel">
					<h2>Sign-in</h2>
					{lockedUntil && (
						<form action={unlockAction} className="note">
							<input type="hidden" name="user_id" value={id} />
							<p>Locked after too many wrong passwords until {dateTime(lockedUntil)} UTC.</p>
							<button type="submit" className="secondary">Unlock now</button>
						</form>
					)}
					<table>
						<tbody>
							<tr><th>Password</th><td>{hasPassword ? 'set' : <span className="muted">none: signs in through the operator only</span>}</td></tr>
							<tr><th>Last sign-in</th><td>{user.last_login_at ? dateTime(user.last_login_at) : <span className="muted">never</span>}</td></tr>
							{user.pc_redirect_url && <tr><th>Operator site</th><td className="muted">{user.pc_redirect_url}</td></tr>}
						</tbody>
					</table>
					<PasswordForm userId={id} hasPassword={hasPassword} />
				</div>
			</div>

			<div className="panel scroll" id="transactions">
				<h2>Transactions</h2>
				<form className="row filters" method="get" action={`/users/${id}#transactions`}>
					<label>What
						<select name="what" defaultValue={query.what}>
							<option value="">everything</option>
							<option value="credits">credit adjustments</option>
							<option value="bets">bets, all games</option>
							{GAMES.map(g => <option key={g} value={g}>{GAME_LABELS[g]} bets</option>)}
						</select>
					</label>
					<label>Outcome
						<select name="outcome" defaultValue={query.outcome}>
							<option value="">any</option>
							{Object.entries(OUTCOME_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
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
					{filtered && <Link href={href({ what : '', outcome : '', from : '', to : '', page : 1 })}>Reset</Link>}
				</form>

				<p className="muted">
					{result.total.toLocaleString('en-US')} transaction{result.total === 1 ? '' : 's'}{filtered ? ' match' : ''}:
					staked {money(result.stake)}, paid out {money(result.payout)}, net change{' '}
					<span className={result.change > 0 ? 'pos' : result.change < 0 ? 'neg' : ''}>{signed(result.change)}</span> {currency}.
				</p>
				<table>
					<thead>
						<tr>
							<SortHeader {...header} sort="time" label="Time (UTC)" />
							<th>What</th>
							<th>Details</th>
							<SortHeader {...header} sort="stake" label="Stake" num />
							<SortHeader {...header} sort="payout" label="Payout" num />
							<SortHeader {...header} sort="change" label="Change" num />
							<th className="num">Balance after</th>
						</tr>
					</thead>
					<tbody>
						{result.rows.map(a => (
							<tr key={a.key}>
								<td className="muted">{dateTime(a.at)}</td>
								<td>{a.label}{a.open && <> <span className="badge">open</span></>}</td>
								<td>{a.detail}{a.by && <span className="muted"> · by {a.by}</span>}</td>
								<td className="num">{a.stake !== null ? money(a.stake) : ''}</td>
								<td className="num">{a.payout !== null ? money(a.payout) : ''}</td>
								<td className={`num ${a.change > 0 ? 'pos' : a.change < 0 ? 'neg' : ''}`}>{signed(a.change)}</td>
								<td className="num">{a.balance !== null ? money(a.balance) : ''}</td>
							</tr>
						))}
						{!result.rows.length && <tr><td colSpan={7} className="muted">{filtered ? 'No transactions match these filters.' : 'No transactions yet.'}</td></tr>}
					</tbody>
				</table>
				<Pager page={result.page} pages={result.pages} size={query.size} total={result.total} shown={result.rows.length} href={page => href({ page })} />
				<p className="muted">Open bets show the stake only; once the round is resulted the change is payout − stake.</p>
			</div>
		</>
	);
}
