import { test } from 'node:test';
import assert from 'node:assert/strict';
import { houseChange, planVoid, PlanError } from '../src/lib/voidPlan.ts';

const users = new Map([
	[1, { _id : 1, vendor_id : 1, money : 1095 }],
	[2, { _id : 2, vendor_id : 1, money : 50 }],
	[3, { _id : 3, vendor_id : 2, money : 0 }]
]);
const vendors = new Map([
	[1, { _id : 1, integration_type : 'transfer' }],
	[2, { _id : 2, integration_type : 'seamless' }]
]);

test('a won bet gives its profit back, a lost one gets its stake back', () => {
	const rows = planVoid([
		{ _id : 10, user_id : 1, total_bet : 100, total_win : 195 },   // banker won: paid stake + 95
		{ _id : 11, user_id : 2, total_bet : 100, total_win : 0 },     // lost
		{ _id : 12, user_id : 3, total_bet : 40, total_win : 40 }      // tie push, seamless
	], users, vendors);

	assert.deepEqual(rows.map(r => [r.betId, r.wallet, r.stake, r.paid, r.change, r.balance, r.after]), [
		[10, 'transfer', 100, 195, -95, 1095, 1000],
		[11, 'transfer', 100, 0, 100, 50, 150],
		[12, 'seamless', 40, 40, 0, null, null]
	]);
	assert.equal(houseChange(rows), -5);
});

test('a balance may go below zero', () => {
	const [row] = planVoid([{ _id : 10, user_id : 2, total_bet : 10, total_win : 300 }], users, vendors);
	assert.equal(row.after, -240);
});

test('skips bets already refunded or rolled back, and empty ones', () => {
	const rows = planVoid([
		{ _id : 10, user_id : 1, total_bet : 100, total_win : 100, status : 'refunded' },
		{ _id : 11, user_id : 1, total_bet : 100, total_win : 100, status : 'rolled_back' },
		{ _id : 12, user_id : 1, total_bet : 0, total_win : 0 }
	], users, vendors);
	assert.deepEqual(rows, []);
});

test('missing player or vendor stops the void', () => {
	assert.throws(() => planVoid([{ _id : 10, user_id : 99, total_bet : 1 }], users, vendors), PlanError);
	assert.throws(() => planVoid([{ _id : 10, user_id : 1, total_bet : 1 }], users, new Map()), PlanError);
});

test('cents stay exact', () => {
	const [row] = planVoid([{ _id : 10, user_id : 1, total_bet : 0.3, total_win : 0.1 }], users, vendors);
	assert.equal(row.change, 0.2);
});
