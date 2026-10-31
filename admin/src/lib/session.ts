/*
 |--------------------------------------------------------------------------
 | admin session
 |--------------------------------------------------------------------------
 | One back-office account from ADMIN_USERNAME / ADMIN_PASSWORD; the signed
 | HS256 JWT cookie carries its name, which goes into every transaction it
 | writes. Every page and server action calls requireAdmin() itself.
 |
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { config } from './config';

const key = () => {
	if (config.session.secret.length < 32) {
		throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters');
	}
	return new TextEncoder().encode(config.session.secret);
};

// hash both sides so the comparison is constant time whatever the lengths
const digest = (value: string) => createHash('sha256').update(value).digest();

export function checkCredentials (username: string, password: string): boolean {
	if (!config.admin.password) return false;
	const userOk = timingSafeEqual(digest(username), digest(config.admin.username));
	const passOk = timingSafeEqual(digest(password), digest(config.admin.password));
	return userOk && passOk;
}

export async function startSession (admin: string) {
	const token = await new SignJWT({ admin })
		.setProtectedHeader({ alg : 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${config.session.maxAge}s`)
		.sign(key());

	(await cookies()).set(config.session.cookie, token, {
		httpOnly : true,
		sameSite : 'lax',
		secure   : config.session.secure,
		path     : '/',
		maxAge   : config.session.maxAge
	});
}

export async function endSession () {
	(await cookies()).delete(config.session.cookie);
}

/** the logged in admin; redirects to /login otherwise */
export async function currentAdmin (): Promise<string | null> {
	const token = (await cookies()).get(config.session.cookie)?.value;
	if (!token) return null;
	try {
		const { payload } = await jwtVerify(token, key());
		return typeof payload.admin === 'string' ? payload.admin : null;
	} catch {
		return null;
	}
}

/** the logged in admin; redirects to /login otherwise */
export async function requireAdmin (): Promise<string> {
	const admin = await currentAdmin();
	if (!admin) redirect('/login');
	return admin;
}
