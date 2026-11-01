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
import { parseName, removeFile, saveFile, setName } from './brand';
import { adjustCredits, createUser, setPassword, unlockUser } from './players';
import { checkCredentials, endSession, requireAdmin, startSession } from './session';
import { Invalid, parseAmount, parseNewUser } from './validate';
import { parseEmbedOrigins, rotateSecret, setEmbedOrigins, setLobbyType } from './vendors';
import { GAMES, type Game } from './config';
import { voidRound } from './rounds';

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

export async function embedOriginsAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	try {
		const vendorId = Number(form.get('vendor_id'));
		const origins = parseEmbedOrigins(String(form.get('origins') ?? ''));
		await setEmbedOrigins(vendorId, origins);
		console.log(`[admin] ${admin} set embed origins of vendor ${vendorId}: ${origins.join(' ') || '(none)'}`);
		revalidatePath('/vendors');
		return { ok : origins.length ? `Saved ${origins.length} site${origins.length === 1 ? '' : 's'}.` : 'Saved: no site can embed the games.' };
	} catch (e) {
		return failure(e);
	}
}

export async function lobbyTypeAction (form: FormData) {
	const admin = await requireAdmin();
	const vendorId = Number(form.get('vendor_id'));
	const integrated = form.get('lobby') === 'integrated';
	await setLobbyType(vendorId, integrated);
	console.log(`[admin] ${admin} set the lobby of vendor ${vendorId} to ${integrated ? 'integrated' : 'normal'}`);
	revalidatePath('/vendors');
}

export async function brandNameAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	try {
		const name = parseName(form.get('name'));
		await setName(name);
		console.log(`[admin] ${admin} renamed the brand to ${name}`);
		revalidatePath('/', 'layout');
		return { ok : `Saved. The player site shows "${name}" within a few seconds.` };
	} catch (e) {
		return failure(e);
	}
}

export async function brandFileAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	try {
		const id = String(form.get('id') ?? '');
		const file = form.get('file');
		if (!(file instanceof File) || !file.size) throw new Invalid('Choose a file first');
		await saveFile(id, Buffer.from(await file.arrayBuffer()), file.name, admin);
		console.log(`[admin] ${admin} uploaded brand file ${id} (${file.name}, ${file.size} bytes)`);
		revalidatePath('/branding');
		return { ok : 'Uploaded.' };
	} catch (e) {
		return failure(e);
	}
}

/** voids a resulted round: every bet rolled back (lib/rounds.ts) */
export async function voidRoundAction (_prev: FormState, form: FormData): Promise<FormState> {
	const admin = await requireAdmin();
	try {
		const game = String(form.get('game') ?? '') as Game;
		const roundId = Number(form.get('round_id'));
		if (!GAMES.includes(game) || !Number.isInteger(roundId) || roundId <= 0) throw new Invalid('Round not found');
		const reason = String(form.get('reason') ?? '').trim().replace(/\s+/g, ' ');
		if (reason.length < 3) throw new Invalid('Give the reason for the void');
		if (reason.length > 200) throw new Invalid('Keep the reason under 200 characters');
		if (form.get('confirm') !== 'on') throw new Invalid('Tick the box to confirm the balance changes');

		const r = await voidRound(game, roundId, reason, admin);
		console.log(`[admin] ${admin} voided ${game} round #${roundId} (${r.roundNum}): ${reason}`);
		revalidatePath('/rounds');
		revalidatePath(`/rounds/${game}/${roundId}`);
		revalidatePath('/transactions');
		revalidatePath('/');
		const players = new Set(r.rows.map(x => x.userId)).size;
		const told = r.told === 'road map' ? 'Players at the table were told and their road maps updated.'
			: r.told === 'notice' ? 'Players at the table were told; their road maps update on their next visit.'
			: 'The players could not be told right away (redis unreachable); they see it on their next visit.';
		return { ok : `Round ${r.roundNum} voided: ${players} player${players === 1 ? '' : 's'} reversed. ${r.mark === 'removed' ? 'Its mark is off the road map.' : 'No road map mark was found for it.'} ${told}` };
	} catch (e) {
		return failure(e);
	}
}

export async function brandRemoveAction (form: FormData) {
	const admin = await requireAdmin();
	const id = String(form.get('id') ?? '');
	await removeFile(id);
	console.log(`[admin] ${admin} removed brand file ${id}`);
	revalidatePath('/branding');
}
