import Link from 'next/link';
import { getDb } from '@/lib/db';
import { dateTime, escapeRegex, intParam, money, strParam } from '@/lib/format';
import { isTransfer } from '@/lib/players';
import { requireAdmin } from '@/lib/session';

const PAGE_SIZE = 50;

type Props = { searchParams : Promise<Record<string, string | string[] | undefined>> };

export default async function PlayersPage ({ searchParams }: Props) {
	await requireAdmin();
	const params = await searchParams;
	const q = strParam(params.q);
	const vendorId = intParam(params.vendor, 0);
	const page = intParam(params.page, 1);

	const db = await getDb();
	const filter: any = { deleted_at : null };
	if (vendorId) filter.vendor_id = vendorId;
	if (q) {
		const rx = new RegExp(escapeRegex(q), 'i');
		filter.$or = [{ user_id : rx }, { user_name : rx }];
		if (/^\d+$/.test(q)) filter.$or.push({ _id : Number(q) });
	}

	const [vendors, users, total]: [any[], any[], number] = await Promise.all([
		db.shared.vendors.find({}, { vendor_name : 1, integration_type : 1, currency : 1 }).sort({ _id : 1 }).lean(),
		db.shared.users.find(filter, { user_id : 1, user_name : 1, vendor_id : 1, money : 1, currency : 1, is_active : 1, created_at : 1 })
			.sort({ _id : -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
		db.shared.users.countDocuments(filter)
	]);
	const vendorById = new Map(vendors.map(v => [v._id, v]));
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const link = (p: number) => `/?${new URLSearchParams({ ...(q && { q }), ...(vendorId && { vendor : String(vendorId) }), page : String(p) })}`;

	return (
		<>
			<div className="spread">
				<h1>Players <span className="muted">({total.toLocaleString('en-US')})</span></h1>
				<Link href="/users/new"><button type="button">Add player</button></Link>
			</div>

			<form className="panel row" method="get">
				<label>Search<input name="q" defaultValue={q} placeholder="login id, name or #id" /></label>
				<label>Vendor
					<select name="vendor" defaultValue={vendorId || ''}>
						<option value="">all</option>
						{vendors.map(v => <option key={v._id} value={v._id}>{v.vendor_name}</option>)}
					</select>
				</label>
				<button type="submit" className="secondary">Filter</button>
			</form>

			<div className="panel scroll">
				<table>
					<thead>
						<tr><th>#</th><th>Login id</th><th>Name</th><th>Vendor</th><th className="num">Balance</th><th>Created</th></tr>
					</thead>
					<tbody>
						{users.map(u => {
							const vendor = vendorById.get(u.vendor_id);
							return (
								<tr key={u._id}>
									<td>{u._id}</td>
									<td><Link href={`/users/${u._id}`}>{u.user_id}</Link>{u.is_active === '0' && <> <span className="badge">inactive</span></>}</td>
									<td>{u.user_name}</td>
									<td>{vendor?.vendor_name ?? u.vendor_id}</td>
									<td className="num">
										{isTransfer(vendor)
											? <>{money(u.money)} <span className="muted">{u.currency || vendor?.currency}</span></>
											: <span className="badge">seamless</span>}
									</td>
									<td className="muted">{dateTime(u.created_at)}</td>
								</tr>
							);
						})}
						{!users.length && <tr><td colSpan={6} className="muted">No players found.</td></tr>}
					</tbody>
				</table>
				{pages > 1 && (
					<div className="pager">
						{page > 1 && <Link href={link(page - 1)}>← Newer</Link>}
						<span className="muted">page {page} of {pages}</span>
						{page < pages && <Link href={link(page + 1)}>Older →</Link>}
					</div>
				)}
			</div>
		</>
	);
}
