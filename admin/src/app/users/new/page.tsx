import { randomUUID } from 'node:crypto';
import { CreateUserForm } from '../../forms';
import { getDb } from '@/lib/db';
import { isTransfer } from '@/lib/players';
import { requireAdmin } from '@/lib/session';
import { CURRENCIES } from '@/lib/validate';

export default async function NewUserPage () {
	await requireAdmin();
	const db = await getDb();
	const vendors: any[] = await db.shared.vendors.find({}, { vendor_name : 1, integration_type : 1, currency : 1 }).sort({ _id : 1 }).lean();

	return (
		<>
			<h1>Add player</h1>
			{!vendors.length
				? <p className="note">There are no vendors yet. Run the seed (<code>docker compose run --rm seed</code>) or create a vendor first.</p>
				: <CreateUserForm
					requestId={randomUUID()}
					currencies={CURRENCIES}
					vendors={vendors.map(v => ({ id : v._id, name : v.vendor_name, currency : v.currency || 'KRW', transfer : isTransfer(v) }))}
				/>}
		</>
	);
}
