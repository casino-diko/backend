/*
 |--------------------------------------------------------------------------
 | form validation
 |--------------------------------------------------------------------------
 | Pure functions (no database), covered by test/validate.test.ts.
 |
 */

// same list as the game-server users / vendors schemas
export const CURRENCIES = ['CNY', 'USD', 'JPY', 'KRW', 'THB', 'MYR', 'IDR', 'RUB', 'UAH', 'GEL', 'EUR', 'GBP',
	'TRY', 'IRR', 'DGN', 'CZK', 'HUF', 'SEK', 'VND', 'HKD', 'BYN', 'INR', 'PTS'];

export const USER_TYPES = ['C', 'S', 'TC', 'TS'];

export const MAX_AMOUNT = 1_000_000_000;

export class Invalid extends Error {}

/** a positive money amount with at most 2 decimals; `optional` allows an empty field (0) */
export function parseAmount (raw: unknown, { optional = false } = {}): number {
	const text = String(raw ?? '').trim().replace(/,/g, '');
	if (!text && optional) return 0;
	if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Invalid('Enter an amount like 100 or 100.50');

	const amount = Number(text);
	if (amount === 0 && optional) return 0;
	if (!(amount > 0)) throw new Invalid('The amount must be more than 0');
	if (amount > MAX_AMOUNT) throw new Invalid(`The amount can't be more than ${MAX_AMOUNT.toLocaleString('en-US')}`);
	return amount;
}

/** add two money amounts without float drift (1000.1 + 0.2) */
export const addMoney = (a: number, b: number) => Math.round((a + b) * 100) / 100;

export type NewUser = {
	vendor_id      : number;
	user_id        : string;
	user_name      : string;
	password       : string;
	currency       : string | null;
	user_type      : string;
	initial_credit : number;
	note           : string;
};

export function parseNewUser (form: FormData): NewUser {
	const text = (name: string) => String(form.get(name) ?? '').trim();

	const vendorId = Number(text('vendor_id'));
	if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Invalid('Pick a vendor');

	const userId = text('user_id');
	if (!/^[A-Za-z0-9_.-]{3,32}$/.test(userId)) {
		throw new Invalid('Login id: 3 to 32 letters, digits, "_", "." or "-"');
	}

	const userName = text('user_name');
	if (!userName || userName.length > 64) throw new Invalid('Display name: 1 to 64 characters');

	const password = String(form.get('password') ?? '');
	if (password && password.length < 8) throw new Invalid('Password: at least 8 characters, or leave it empty');

	const currency = text('currency') || null;
	if (currency && !CURRENCIES.includes(currency)) throw new Invalid('Unknown currency');

	const userType = text('user_type') || 'C';
	if (!USER_TYPES.includes(userType)) throw new Invalid('Unknown player type');

	return {
		vendor_id      : vendorId,
		user_id        : userId,
		user_name      : userName,
		password,
		currency,
		user_type      : userType,
		initial_credit : parseAmount(form.get('initial_credit'), { optional : true }),
		note           : text('note').slice(0, 200)
	};
}
