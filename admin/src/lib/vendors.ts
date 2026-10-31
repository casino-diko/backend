/*
 |--------------------------------------------------------------------------
 | vendors (operators)
 |--------------------------------------------------------------------------
 | vendors.secret_key signs an operator's launch links to the player
 | front-end (web repo: src/lib/launch.ts, at least 32 characters) and, for
 | seamless vendors, the wallet calls between us and the operator. A new
 | secret takes effect at once for both, so the operator must switch to it
 | at the same time.
 |
 */

import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import { Invalid } from './validate';

/** a new 64 character secret, returned once to show to the admin */
export async function rotateSecret (vendorId: number): Promise<string> {
	const db = await getDb();
	const secret = randomBytes(32).toString('hex');
	const res = await db.shared.vendors.updateOne({ _id : vendorId }, { $set : { secret_key : secret } });
	if (!res.matchedCount) throw new Invalid('Vendor not found');
	return secret;
}
