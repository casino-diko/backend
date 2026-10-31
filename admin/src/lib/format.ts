export const money = (value: unknown) =>
	(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits : 0, maximumFractionDigits : 2 });

export const signed = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '') + money(Math.abs(value));

export const dateTime = (value: unknown) => {
	if (!value) return '';
	const d = new Date(value as any);
	return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').slice(0, 19);
};

/** a positive integer from a search param, or the fallback */
export const intParam = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
	const n = Number(Array.isArray(value) ? value[0] : value);
	return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

export const strParam = (value: unknown) => String((Array.isArray(value) ? value[0] : value) ?? '').trim();

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
