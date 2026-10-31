import { EmbedOriginsForm, SecretForm } from '../forms';
import { lobbyTypeAction } from '@/lib/actions';
import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/session';

const MIN_SECRET = 32; // what the player front-end's /launch accepts (web repo: src/lib/launch.ts)

export default async function VendorsPage () {
	await requireAdmin();
	const db = await getDb();
	const [vendors, counts]: [any[], any[]] = await Promise.all([
		db.shared.vendors.find({}, { vendor_name : 1, integration_type : 1, currency : 1, is_active : 1, secret_key : 1, embed_origins : 1, lobby_type : 1 }).sort({ _id : 1 }).lean(),
		db.shared.users.aggregate([{ $match : { deleted_at : null } }, { $group : { _id : '$vendor_id', n : { $sum : 1 } } }])
	]);
	const players = new Map(counts.map(c => [c._id, c.n]));

	return (
		<>
			<h1>Vendors</h1>
			<div className="panel">
				<p>
					Operators send their players in with a signed launch link. Each vendor signs with its own secret, which also
					signs the seamless wallet calls. Give the secret to the operator over a secure channel.
				</p>
				<p className="muted">
					<code>{config.playerSite}/launch?vendor=&lt;vendor name&gt;&amp;payload=&lt;base64url JSON&gt;&amp;hash=&lt;HMAC-SHA256 hex&gt;</code>
					{' '}· the operator guide is <code>OPERATORS.md</code> in the web repo.
				</p>
			</div>
			{vendors.map(v => {
				const secret = String(v.secret_key || '');
				const status = !secret ? 'no secret: launch links are refused'
					: secret.length < MIN_SECRET ? `secret too short (${secret.length} characters): launch links are refused`
						: 'secret set';
				return (
					<div className="panel" key={v._id}>
						<div className="spread">
							<h2>{v.vendor_name} <span className="muted">#{v._id}</span></h2>
							<span>
								<span className="badge">{v.integration_type === 'seamless' ? 'seamless' : 'transfer'}</span>{' '}
								<span className="badge">{v.currency}</span>{' '}
								{v.is_active === '0' && <span className="badge">inactive</span>}
							</span>
						</div>
						<p className={secret.length >= MIN_SECRET ? 'muted' : 'error'}>{(players.get(v._id) || 0).toLocaleString('en-US')} players · {status}</p>
						<form action={lobbyTypeAction} className="row filters">
							<input type="hidden" name="vendor_id" value={v._id} />
							<label>Lobby
								<select name="lobby" defaultValue={v.lobby_type === 'integrated' ? 'integrated' : 'normal'}>
									<option value="normal">ours: players pick tables in our lobby</option>
									<option value="integrated">the operator&apos;s: the lobby button returns to their site</option>
								</select>
							</label>
							<button type="submit" className="secondary">Save lobby</button>
						</form>
						<div className="grid">
							<SecretForm vendorId={v._id} vendorName={v.vendor_name} hasSecret={!!secret} />
							<EmbedOriginsForm vendorId={v._id} origins={Array.isArray(v.embed_origins) ? v.embed_origins : []} />
						</div>
					</div>
				);
			})}
		</>
	);
}
