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
 | vendors.embed_origins: the operator sites allowed to show the games in an
 | iframe (launch links with `embed`; the web repo's src/lib/frame.ts applies
 | them as Content-Security-Policy frame-ancestors with the same rules).
 |
 | vendors.lobby_type: 'integrated' when the operator lists the tables
 | itself (the games' lobby button returns players to its lobby_url), else
 | players use our lobby.
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

/** `scheme://host[:port]`, https only (http just for localhost, for testing); same rules as the web's frame.ts */
export function embedOrigin (value: string): string | null {
	try {
		const url = new URL(value.trim());
		const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
		if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
		return url.origin;
	} catch {
		return null;
	}
}

/** one site per line (or comma separated); refuses the whole list when one line is not a site */
export function parseEmbedOrigins (text: string): string[] {
	const lines = text.split(/[\n,]/).map(l => l.trim()).filter(Boolean);
	if (lines.length > 20) throw new Invalid('At most 20 sites');
	const origins: string[] = [];
	for (const line of lines) {
		const origin = embedOrigin(line);
		if (!origin) throw new Invalid(`Not a site: "${line.slice(0, 80)}". Use https://host or https://host:port (http only for localhost)`);
		if (!origins.includes(origin)) origins.push(origin);
	}
	return origins;
}

export async function setEmbedOrigins (vendorId: number, origins: string[]): Promise<void> {
	const db = await getDb();
	const res = await db.shared.vendors.updateOne({ _id : vendorId }, origins.length ? { $set : { embed_origins : origins } } : { $unset : { embed_origins : 1 } });
	if (!res.matchedCount) throw new Invalid('Vendor not found');
}

export async function setLobbyType (vendorId: number, integrated: boolean): Promise<void> {
	const db = await getDb();
	const res = await db.shared.vendors.updateOne({ _id : vendorId }, { $set : { lobby_type : integrated ? 'integrated' : 'normal' } });
	if (!res.matchedCount) throw new Invalid('Vendor not found');
}
