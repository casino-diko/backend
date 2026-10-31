'use server';

/*
 |--------------------------------------------------------------------------
 | server actions (forms)
 |--------------------------------------------------------------------------
 | Every action checks the admin session itself. Forms carry a request_id
 | rendered with the page, so a double click or a browser resubmit doesn't
 | credit twice (unique index on transactions.request_id).
 |
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { adjustCredits, createUser, setPassword, unlockUser } from './players';
import { checkCredentials, endSession, requireAdmin, startSession } from './session';
import { Invalid, parseAmount, parseNewUser } from './validate';
import { rotateSecret } from './vendors';

export type FormState = { error? : string; ok? : string; secret? : string } | null;

const failure = (e: unknown): FormState => {
	if (e instanceof Invalid) return { error : e.message };
	console.error('[admin]', e);
	return { error : 'Something went wrong, please try again' };
};

export async function login (_prev: FormState, form: FormData): Promise<FormState> {
	const username = String(form.get('username') ?? '');
	if (!checkCredentials(username, String(form.get('password') ?? ''))) {
		return { error : 'Wrong username or password' };
	}
	await startSession(username);
	redirect('/');
}

export async function logout () {
	await endSession();
	redirect('/login');
}

export async function createUserAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	let id: number;
	try {
		id = await createUser(parseNewUser(form), admin, String(form.get('request_id') ?? ''));
	} catch (e) {
		return failure(e);
	}
	revalidatePath('/');
	redirect(`/users/${id}?created=1`);
}

export async function adjustCreditsAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	try {
		const userId = Number(form.get('user_id'));
		const type = form.get('type') === 'debit' ? 'debit' : 'credit';
		const amount = parseAmount(form.get('amount'));
		const { balance, duplicate } = await adjustCredits({
			userId, type, amount, admin,
			note      : String(form.get('note') ?? '').trim().slice(0, 200),
			requestId : String(form.get('request_id') ?? '')
		});
		revalidatePath(`/users/${userId}`);
		revalidatePath('/transactions');
		revalidatePath('/');
		if (duplicate) return { ok : `Already applied. Balance: ${balance.toLocaleString('en-US')}` };
		return { ok : `${type === 'credit' ? 'Added' : 'Deducted'} ${amount.toLocaleString('en-US')}. New balance: ${balance.toLocaleString('en-US')}` };
	} catch (e) {
		return failure(e);
	}
}

export async function setPasswordAction (_prev: FormState, form: FormData): Promise<FormState> {
	await requireAdmin();
	try {
		const userId = Number(form.get('user_id'));
		await setPassword(userId, String(form.get('password') ?? ''));
		revalidatePath(`/users/${userId}`);
		return { ok : 'Password set. The player can sign in with it now.' };
	} catch (e) {
		return failure(e);
	}
}

export async function unlockAction (form: FormData) {
	await requireAdmin();
	const userId = Number(form.get('user_id'));
	await unlockUser(userId);
	revalidatePath(`/users/${userId}`);
}

export async function rotateSecretAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	try {
		const vendorId = Number(form.get('vendor_id'));
		const secret = await rotateSecret(vendorId);
		console.log(`[admin] ${admin} generated a new secret for vendor ${vendorId}`);
		revalidatePath('/vendors');
		return { ok : 'New secret saved. Copy it now: it is not shown again.', secret };
	} catch (e) {
		return failure(e);
	}
}
