'use client';

import { useActionState } from 'react';
import { adjustCreditsAction, createUserAction, login, type FormState } from '@/lib/actions';

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
