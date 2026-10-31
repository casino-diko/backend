import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Invalid, MAX_AMOUNT, addMoney, parseAmount, parseNewUser } from '../src/lib/validate.ts';

test('parseAmount accepts positive amounts with up to 2 decimals', () => {
	assert.equal(parseAmount('100'), 100);
	assert.equal(parseAmount(' 100.5 '), 100.5);
	assert.equal(parseAmount('1,000.25'), 1000.25);
	assert.equal(parseAmount(String(MAX_AMOUNT)), MAX_AMOUNT);
});

test('parseAmount refuses zero, negatives, junk and too many decimals', () => {
	for (const bad of ['', '0', '0.00', '-5', 'abc', '1e5', '1.234', '.5', String(MAX_AMOUNT + 1), null, undefined]) {
		assert.throws(() => parseAmount(bad), Invalid, String(bad));
	}
});

test('parseAmount optional: empty and zero mean no amount', () => {
	assert.equal(parseAmount('', { optional : true }), 0);
	assert.equal(parseAmount('0', { optional : true }), 0);
	assert.equal(parseAmount('25', { optional : true }), 25);
	assert.throws(() => parseAmount('-1', { optional : true }), Invalid);
});

test('addMoney rounds to cents', () => {
	assert.equal(addMoney(0.1, 0.2), 0.3);
	assert.equal(addMoney(1000.1, -0.2), 999.9);
});

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};

const valid = { vendor_id : '1', user_id : 'player_9', user_name : 'Nine', password : '', currency : '', user_type : 'C', initial_credit : '', note : '' };

test('parseNewUser returns the cleaned player', () => {
	assert.deepEqual(parseNewUser(form({ ...valid, user_name : '  Nine  ', initial_credit : '500', currency : 'USD' })), {
		vendor_id : 1, user_id : 'player_9', user_name : 'Nine', password : '', currency : 'USD',
		user_type : 'C', initial_credit : 500, note : ''
	});
});

test('parseNewUser refuses bad fields', () => {
	const cases: Record<string, string>[] = [
		{ vendor_id : '' },
		{ vendor_id : 'x' },
		{ user_id : 'ab' },
		{ user_id : 'has space' },
		{ user_id : 'a'.repeat(33) },
		{ user_name : '' },
		{ password : 'short' },
		{ currency : 'XXX' },
		{ user_type : 'Z' },
		{ initial_credit : '-1' }
	];
	for (const c of cases) assert.throws(() => parseNewUser(form({ ...valid, ...c })), Invalid, JSON.stringify(c));
});
