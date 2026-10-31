import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreditForm } from '../../forms';
import { getDb } from '@/lib/db';
import { dateTime, intParam, money, signed, strParam } from '@/lib/format';
import { isTransfer, userActivity } from '@/lib/players';
import { requireAdmin } from '@/lib/session';

type Props = {
	params       : Promise<{ id : string }>;
	searchParams : Promise<Record<string, string | string[] | undefined>>;
};

const SHOW = { all : 'Everything', credits : 'Credit adjustments', bets : 'Game bets' } as const;

export default async function UserPage ({ params, searchParams }: Props) {
	await requireAdmin();
	const id = Number((await params).id);
	if (!Number.isInteger(id)) notFound();
	const query = await searchParams;
	const limit = intParam(query.limit, 50, 1000);
	const show = (strParam(query.show) in SHOW ? strParam(query.show) : 'all') as keyof typeof SHOW;

	const db = await getDb();
	const user: any = await db.shared.users.findOne({ _id : id, deleted_at : null }).lean();
	if (!user) notFound();
	const vendor: any = await db.shared.vendors.findById(user.vendor_id).lean();
	const transfer = isTransfer(vendor);
	const currency = user.currency || vendor?.currency || '';

	const activity = await userActivity(id, limit, { credits : show !== 'bets', bets : show !== 'credits' });
	const link = (p: Record<string, string>) => `/users/${id}?${new URLSearchParams({ show, limit : String(limit), ...p })}`;

	return (
		<>
			<p><Link href="/">← Players</Link></p>
			{query.created && <p className="ok">Player created.</p>}
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
			</div>

			<div className="panel scroll">
				<div className="spread">
					<h2>Transactions</h2>
					<div className="seg tabs">
						{Object.entries(SHOW).map(([key, label]) => (
							<Link key={key} href={link({ show : key })} className={show === key ? 'on' : ''}>{label}</Link>
						))}
					</div>
				</div>
				<table>
					<thead>
						<tr><th>Time (UTC)</th><th>What</th><th>Details</th><th className="num">Stake</th><th className="num">Payout</th><th className="num">Change</th><th className="num">Balance after</th></tr>
					</thead>
					<tbody>
						{activity.map(a => (
							<tr key={a.key}>
								<td className="muted">{dateTime(a.at)}</td>
								<td>{a.label}{a.pending && <> <span className="badge">open</span></>}</td>
								<td>{a.detail}{a.by && <span className="muted"> · by {a.by}</span>}</td>
								<td className="num">{a.stake !== undefined ? money(a.stake) : ''}</td>
								<td className="num">{a.payout !== undefined ? money(a.payout) : ''}</td>
								<td className={`num ${a.amount > 0 ? 'pos' : a.amount < 0 ? 'neg' : ''}`}>{signed(a.amount)}</td>
								<td className="num">{a.balance !== undefined && a.balance !== null ? money(a.balance) : ''}</td>
							</tr>
						))}
						{!activity.length && <tr><td colSpan={7} className="muted">No transactions yet.</td></tr>}
					</tbody>
				</table>
				{activity.length >= limit && limit < 1000 && (
					<div className="pager"><Link href={link({ limit : String(Math.min(limit * 2, 1000)) })}>Show more</Link></div>
				)}
				<p className="muted">Open bets show the stake only; once the round is resulted the change is payout − stake.</p>
			</div>
		</>
	);
}
