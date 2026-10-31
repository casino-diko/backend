'use client';

import { useActionState } from 'react';
import { adjustCreditsAction, brandFileAction, brandNameAction, createUserAction, embedOriginsAction, login, rotateSecretAction, setPasswordAction, type FormState } from '@/lib/actions';

const Message = ({ state }: { state : FormState }) => (
	<>
		{state?.error && <p className="error" role="alert">{state.error}</p>}
		{state?.ok && <p className="ok" role="status">{state.ok}</p>}
	</>
);

export function LoginForm () {
	const [state, action, pending] = useActionState(login, null);
	return (
		<form action={action}>
			<Message state={state} />
			<label>Username<input name="username" autoComplete="username" required autoFocus /></label>
			<label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
			<button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
		</form>
	);
}

type Vendor = { id : number; name : string; currency : string; transfer : boolean };

export function CreateUserForm ({ vendors, currencies, requestId }: { vendors : Vendor[]; currencies : string[]; requestId : string }) {
	const [state, action, pending] = useActionState(createUserAction, null);
	return (
		<form action={action} className="panel">
			<Message state={state} />
			<input type="hidden" name="request_id" value={requestId} />
			<div className="grid">
				<div>
					<label>Vendor
						<select name="vendor_id" required defaultValue={vendors.find(v => v.transfer)?.id ?? ''}>
							{vendors.map(v => (
								<option key={v.id} value={v.id}>
									{v.name} · {v.currency} · {v.transfer ? 'transfer wallet' : 'seamless wallet'}
								</option>
							))}
						</select>
					</label>
					<label>Login id <small>(3–32 letters, digits, _ . -)</small>
						<input name="user_id" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_.\-]+" autoComplete="off" />
					</label>
					<label>Display name<input name="user_name" required maxLength={64} autoComplete="off" /></label>
					<label>Password <small>(optional, 8+ characters)</small>
						<input name="password" type="password" minLength={8} autoComplete="new-password" />
					</label>
				</div>
				<div>
					<label>Currency <small>(empty: the vendor&apos;s)</small>
						<select name="currency" defaultValue="">
							<option value="">vendor default</option>
							{currencies.map(c => <option key={c} value={c}>{c}</option>)}
						</select>
					</label>
					<label>Player type
						<select name="user_type" defaultValue="C">
							<option value="C">C · casino</option>
							<option value="S">S · sports</option>
							<option value="TC">TC · test casino</option>
							<option value="TS">TS · test sports</option>
						</select>
					</label>
					<label>Initial credits <small>(optional, transfer wallets only)</small>
						<input name="initial_credit" inputMode="decimal" placeholder="0" autoComplete="off" />
					</label>
					<label>Note for the initial credit <small>(optional)</small>
						<input name="note" maxLength={200} autoComplete="off" />
					</label>
				</div>
			</div>
			<button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create player'}</button>
		</form>
	);
}

export function CreditForm ({ userId, requestId }: { userId : number; requestId : string }) {
	const [state, action, pending] = useActionState(adjustCreditsAction, null);
	return (
		// a new request id after every success remounts the form, which also clears the fields
		<form action={action} key={requestId}>
			<Message state={state} />
			<input type="hidden" name="user_id" value={userId} />
			<input type="hidden" name="request_id" value={requestId} />
			<div className="seg">
				<label><input type="radio" name="type" value="credit" defaultChecked />Add</label>
				<label><input type="radio" name="type" value="debit" />Deduct</label>
			</div>
			<label>Amount<input name="amount" inputMode="decimal" required placeholder="100.00" autoComplete="off" /></label>
			<label>Note <small>(optional)</small><input name="note" maxLength={200} autoComplete="off" /></label>
			<button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Apply'}</button>
		</form>
	);
}

export function PasswordForm ({ userId, hasPassword }: { userId : number; hasPassword : boolean }) {
	const [state, action, pending] = useActionState(setPasswordAction, null);
	return (
		<form action={action}>
			<Message state={state} />
			<input type="hidden" name="user_id" value={userId} />
			<label>{hasPassword ? 'New password' : 'Password'} <small>(8+ characters)</small>
				<input name="password" type="password" minLength={8} maxLength={200} required autoComplete="new-password" />
			</label>
			<button type="submit" className="secondary" disabled={pending}>{pending ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}</button>
		</form>
	);
}

/** generates a vendor's launch secret; the new secret is shown once, with a sample launch query */
export function SecretForm ({ vendorId, vendorName, hasSecret }: { vendorId : number; vendorName : string; hasSecret : boolean }) {
	const [state, action, pending] = useActionState(rotateSecretAction, null);
	return (
		<form action={action}>
			<input type="hidden" name="vendor_id" value={vendorId} />
			{state?.error && <p className="error" role="alert">{state.error}</p>}
			{state?.secret
				? <div className="note">
					<p className="ok">{state.ok}</p>
					<label>Secret for {vendorName}<input readOnly value={state.secret} onFocus={e => e.currentTarget.select()} /></label>
				</div>
				: <>
					{hasSecret && (
						<label className="check">
							<input type="checkbox" name="confirm" required />
							<span>Replace the current secret. The operator&apos;s launch links (and seamless wallet calls) stop working until they switch.</span>
						</label>
					)}
					<button type="submit" className="secondary" disabled={pending}>{pending ? 'Generating…' : hasSecret ? 'Generate a new secret' : 'Generate a secret'}</button>
				</>}
		</form>
	);
}

/** the operator sites allowed to show the games in an iframe, one per line */
export function EmbedOriginsForm ({ vendorId, origins }: { vendorId : number; origins : string[] }) {
	const [state, action, pending] = useActionState(embedOriginsAction, null);
	return (
		<form action={action}>
			<Message state={state} />
			<input type="hidden" name="vendor_id" value={vendorId} />
			<label>Sites that may embed the games <small>(one per line, e.g. https://casino.example)</small>
				<textarea name="origins" rows={Math.max(2, origins.length + 1)} defaultValue={origins.join('\n')} spellCheck={false} />
			</label>
			<button type="submit" className="secondary" disabled={pending}>{pending ? 'Saving…' : 'Save sites'}</button>
		</form>
	);
}

export function BrandNameForm ({ name }: { name : string }) {
	const [state, action, pending] = useActionState(brandNameAction, null);
	return (
		<form action={action} className="row">
			<label>Brand name<input name="name" defaultValue={name} required maxLength={40} autoComplete="off" /></label>
			<button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save name'}</button>
			<div style={{ flexBasis : '100%' }}><Message state={state} /></div>
		</form>
	);
}

/** one upload slot: logo, icon or a welcome sound */
export function BrandUploadForm ({ id, accept, label }: { id : string; accept : string; label : string }) {
	const [state, action, pending] = useActionState(brandFileAction, null);
	return (
		<form action={action} className="row upload">
			<input type="hidden" name="id" value={id} />
			<label>{label}<input type="file" name="file" accept={accept} required /></label>
			<button type="submit" className="secondary" disabled={pending}>{pending ? 'Uploading…' : 'Upload'}</button>
			<div style={{ flexBasis : '100%' }}><Message state={state} /></div>
		</form>
	);
}
