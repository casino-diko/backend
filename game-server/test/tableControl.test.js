'use strict';

/*
 | Round cancel refunds and the last rounds countdown (no database needed).
 |   node --test test/tableControl.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { planRefunds, countDown, refundsByUser, TableControlError } = require('../src/core/tableControl');

const users = {
	1 : { _id : 1, vendor_id : 1, money : 900 },
	3 : { _id : 3, vendor_id : 2, money : 0 }
};
const vendors = {
	1 : { _id : 1, integration_type : 'transfer' },
	2 : { _id : 2, integration_type : 'seamless' }
};

describe('planRefunds', () => {
	test('gives every stake back, by wallet type', () => {
		const plan = planRefunds([
			{ _id : 10, user_id : 1, total_bet : 100 },
			{ _id : 11, user_id : 3, total_bet : 250.5 }
		], users, vendors);

		assert.deepEqual(plan.map(p => [p.betId, p.userId, p.amount, p.wallet]), [
			[10, 1, 100, 'transfer'],
			[11, 3, 250.5, 'seamless']
		]);
	});

	test('skips empty stakes and bets already refunded or rolled back', () => {
		const plan = planRefunds([
			{ _id : 10, user_id : 1, total_bet : 0 },
			{ _id : 11, user_id : 1, total_bet : null },
			{ _id : 12, user_id : 1, total_bet : 50, status : 'refunded' },
			{ _id : 13, user_id : 1, total_bet : 50, status : 'rolled_back' },
			{ _id : 14, user_id : 1, total_bet : 50 }
		], users, vendors);

		assert.deepEqual(plan.map(p => p.betId), [14]);
	});

	test('a bet whose player or vendor is missing stops the cancel', () => {
		assert.throws(() => planRefunds([{ _id : 10, user_id : 99, total_bet : 10 }], users, vendors), TableControlError);
		assert.throws(() => planRefunds([{ _id : 10, user_id : 1, total_bet : 10 }], users, {}), TableControlError);
	});
});

describe('refundsByUser', () => {
	test('one row per player, the new balance for transfer wallets only', () => {
		const plan = planRefunds([
			{ _id : 10, user_id : 1, total_bet : 100 },
			{ _id : 11, user_id : 1, total_bet : 0.1 },
			{ _id : 12, user_id : 3, total_bet : 0.2 }
		], users, vendors);

		assert.deepEqual(refundsByUser(plan, { 1 : 1000.1 }), [
			{ id : 1, amount : 100.1, money : 1000.1 },
			{ id : 3, amount : 0.2, money : null }
		]);
	});
});

describe('countDown', () => {
	test('no countdown', () => {
		for (const v of [0, null, undefined, -1, 'x']) {
			assert.deepEqual(countDown(v), { counting : false, left : 0, closes : false });
		}
	});

	test('counts one result down and closes on the last', () => {
		assert.deepEqual(countDown(3), { counting : true, left : 2, closes : false });
		assert.deepEqual(countDown(1), { counting : true, left : 0, closes : true });
	});
});
