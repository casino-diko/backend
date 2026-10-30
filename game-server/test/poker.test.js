'use strict';

/*
 | Unit tests of the poker rules: hand evaluation, bonus paytables, payouts
 | and the settlement plan of processBets (database calls are mocked).
 |
 |   node --test test/poker.test.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const _      = require('lodash');

const deck     = require('../src/games/poker/cardsModule');
const services = require('../src/games/poker/services');
const models   = require('../src/games/poker/db');

// name -> barcode ('AH' -> '0013')
const code = name => deck('0000').getCodeByName(name).code;
const gameInfo = ({ player, dealer, flop, turn, river }) => ({
	burn   : [],
	player : player.map(code),
	dealer : dealer.map(code),
	flop   : flop.map(code),
	turn   : turn ? code(turn) : null,
	river  : river ? code(river) : null
});

const bet = (extra = {}) => Object.assign({
	ante : { bet : 10 }, flop : { bet : 20 }, turn : { bet : 10 }, river : { bet : 10 }, bonus : { bet : 5 }
}, extra);

test('cards: barcodes and names', () => {
	assert.equal(deck('0000').name, 'AC');
	assert.equal(deck('0022').name, 'TH');
	assert.equal(deck('0051').name, 'KS');
	assert.equal(deck('9999').name, null);
	assert.equal(code('QD'), '0037');
	assert.deepEqual(services.convertInput({ player : ['0013', '0026'], dealer : [], flop : [], burn : [], turn : '0012', river : null }),
		{ turn : 'KC', river : null, player : ['AH', 'AD'], flop : [], burn : [], dealer : [] });
});

test('getCardType', async () => {
	assert.equal(await services.getCardType('0013'), 'card');
	assert.equal(await services.getCardType('D0001'), 'dealer');
	await assert.rejects(services.getCardType('X0001x'), e => e === 'unrecognized card');
	await assert.rejects(services.getCardType(null), e => e === 'unrecognized card');
});

test('evaluateHands: player / dealer / tie', () => {
	const player = services.evaluateHands(gameInfo({
		player : ['AH', 'AD'], dealer : ['5C', '6C'], flop : ['AC', '7S', '2D'], turn : 'KC', river : '9H'
	}));
	assert.equal(player.winSide, 'player');
	assert.equal(player.handtype, 'Three of a Kind');

	const dealer = services.evaluateHands(gameInfo({
		player : ['2H', '3D'], dealer : ['KH', 'KD'], flop : ['AC', '7S', '9D'], turn : 'JC', river : '4H'
	}));
	assert.equal(dealer.winSide, 'dealer');
	assert.equal(dealer.handtype, 'Pair');

	// board plays: both use AK QJ T straight
	const tie = services.evaluateHands(gameInfo({
		player : ['2H', '3D'], dealer : ['2C', '4S'], flop : ['AC', 'KS', 'QD'], turn : 'JC', river : 'TH'
	}));
	assert.equal(tie.winSide, 'tie');
	assert.equal(tie.handtype, 'Straight');

	const royal = services.evaluateHands(gameInfo({
		player : ['AH', 'KH'], dealer : ['2C', '7D'], flop : ['QH', 'JH', '3S'], turn : 'TH', river : '9S'
	}));
	assert.equal(royal.winSide, 'player');
	assert.equal(royal.handtype, 'Royal Flush');
});

test('evaluateHands: incomplete rounds', () => {
	assert.throws(() => services.evaluateHands(gameInfo({
		player : ['AH', 'AD'], dealer : ['5C', '6C'], flop : ['AC', '7S', '2D'], turn : 'KC'
	})), e => e === 'river empty');

	assert.throws(() => services.evaluateHands(gameInfo({
		player : ['AH'], dealer : ['5C', '6C'], flop : ['AC', '7S', '2D'], turn : 'KC', river : '9H'
	})), e => e === 'insufficient cards');

	// duplicated card
	assert.throws(() => services.evaluateHands(gameInfo({
		player : ['AH', 'AC'], dealer : ['5C', '6C'], flop : ['AC', '7S', '2D'], turn : 'KC', river : '9H'
	})), e => e === 'insufficient cards');
});

test('bonus paytable (type r) and pocket paytable (type b)', async () => {
	const bonus = async (hand, type) => {
		const r = await deck('0000').getBonus(hand, { type, badbeat : false });
		return r.length ? r[0] : 0;
	};
	const cases = [
		// hand,            r,  b
		[['AH', 'AD'],      30, 30],
		[['AH', 'KH'],      25, 0],
		[['AS', 'QS'],      20, 0],
		[['JD', 'AD'],      20, 0],
		[['AH', 'KC'],      15, 0],
		[['AH', 'QC'],      5,  0],
		[['JC', 'AH'],      5,  0],
		[['KH', 'KD'],      10, 3],
		[['QH', 'QD'],      10, 3],
		[['JH', 'JD'],      10, 3],
		[['TH', 'TD'],      3,  3],
		[['2H', '2D'],      3,  3],
		[['2H', '7D'],      0,  0],
		[['KH', 'QH'],      0,  0]
	];
	for (const [hand, r, b] of cases) {
		assert.equal(await bonus(hand, 'r'), r, `${hand} bonus`);
		assert.equal(await bonus(hand, 'b'), b, `${hand} pocket`);
	}
});

test('ante bonus (bonusplus) and ante payout odds', () => {
	assert.equal(services.getAnteBonus('Royal Flush', 0), 500);
	assert.equal(services.getAnteBonus('Royal Flush', 1), 500);
	assert.equal(services.getAnteBonus('Straight Flush, K High', 0), 50);
	assert.equal(services.getAnteBonus('Straight Flush, K High', 1), 500);
	assert.equal(services.getAnteBonus('Four of a Kind, A\'s', 1), 50);
	assert.equal(services.getAnteBonus('Full House, A\'s over K\'s', 0), 3);
	assert.equal(services.getAnteBonus('Flush, A High', 0), 1.5);
	assert.equal(services.getAnteBonus('Flush, A High', 1), 8);
	assert.equal(services.getAnteBonus('Straight, A High', 1), 5);
	assert.equal(services.getAnteBonus('Three of a Kind, A\'s', 0), 0);
	assert.equal(services.getAnteBonus('Pair, A\'s', 1), 0);

	assert.equal(services.getAntePayoutOdds('Straight, 9 High'), 1);
	assert.equal(services.getAntePayoutOdds('Royal Flush'), 1);
	assert.equal(services.getAntePayoutOdds('Three of a Kind, A\'s'), 0);
	assert.equal(services.getAntePayoutOdds('A High'), 0);
});

test('payout: player wins', () => {
	// ante pushes (no straight), flop/turn/river 1:1, bonus 30x
	let r = services.payoutHandler.player({ bh : bet(), bonusAmount : 30, anteBonusOdds : 0, anteBonusPlusAmount : 0, bonus : 'bonus' });
	assert.equal(r.totalBet, 55);
	assert.equal(r.totalWinning, 190);
	assert.equal(r.totalWin, 245);
	assert.equal(r.totalLost, 0);
	assert.equal(r.totalRolling, 45);
	assert.equal(r.bh.ante.win, 10);
	assert.equal(r.bh.flop.win, 40);
	assert.equal(r.bh.bonus.win, 155);

	// ante pays with straight or better, bonus lost
	r = services.payoutHandler.player({ bh : bet(), bonusAmount : 0, anteBonusOdds : 1, anteBonusPlusAmount : 0, bonus : 'bonus' });
	assert.equal(r.totalWinning, 50);
	assert.equal(r.totalWin, 100);
	assert.equal(r.totalLost, 5);
	assert.equal(r.totalRolling, 55);
	assert.equal(r.bh.ante.win, 20);

	// pocket bet with bonusplus win
	r = services.payoutHandler.player({
		bh : bet({ bonus : undefined, pocket : { bet : 5 }, bonusplus : { bet : 5 } }),
		bonusAmount : 3, anteBonusOdds : 1, anteBonusPlusAmount : 8, bonus : 'pocket'
	});
	assert.equal(r.totalBet, 60);
	assert.equal(r.totalWinning, 50 + 15 + 40);
	assert.equal(r.totalWin, 60 + 105);
	assert.equal(r.bh.bonusplus.win, 45);
	assert.equal(r.bh.pocket.win, 20);

	// bonusplus is ignored on a regular (bonus) bet
	r = services.payoutHandler.player({
		bh : bet({ bonusplus : { bet : 5 } }), bonusAmount : 0, anteBonusOdds : 0, anteBonusPlusAmount : 8, bonus : 'bonus'
	});
	assert.equal(r.totalLost, 10);
});

test('payout: tie', () => {
	let r = services.payoutHandler.tie({ bh : bet(), bonusAmount : 0, anteBonusPlusAmount : 0, bonus : 'bonus' });
	assert.equal(r.totalBet, 55);
	assert.equal(r.totalWin, 50);  // main bets refunded
	assert.equal(r.totalLost, 5);
	assert.equal(r.totalRolling, 5);
	assert.deepEqual([r.bh.ante.win, r.bh.flop.win, r.bh.turn.win, r.bh.river.win], [10, 20, 10, 10]);

	r = services.payoutHandler.tie({ bh : bet(), bonusAmount : 10, anteBonusPlusAmount : 0, bonus : 'bonus' });
	assert.equal(r.totalWinning, 50);
	assert.equal(r.totalWin, 50 + 5 + 50);
	assert.equal(r.totalLost, 0);
});

test('payout: dealer wins', () => {
	let r = services.payoutHandler.dealer({ bh : bet(), bonusAmount : 0, anteBonusPlusAmount : 0, bonus : 'bonus' });
	assert.equal(r.totalWin, 0);
	assert.equal(r.totalLost, 55);
	assert.equal(r.totalRolling, 55);

	// bonus is independent from the main bets; bad beat bonusplus on a pocket bet
	r = services.payoutHandler.dealer({
		bh : bet({ bonus : undefined, pocket : { bet : 5 }, bonusplus : { bet : 5 } }),
		bonusAmount : 30, anteBonusPlusAmount : 50, bonus : 'pocket'
	});
	assert.equal(r.totalLost, 50);
	assert.equal(r.totalWinning, 150 + 250);
	assert.equal(r.totalWin, 5 + 5 + 400);
});

test('processBets: settlement plan (transfer credited, seamless not, folded bet)', async t => {
	const calls = {};
	const record = name => async (...args) => {
		(calls[name] = calls[name] || []).push(args);
		if (name === 'rounds.updateOne') return { matchedCount : 1 };
		if (name === 'bets.bulkWrite') return { matchedCount : args[0].length };
		return null;
	};

	t.mock.method(models, 'withTransaction', async fn => fn('session'));
	t.mock.method(models.rounds, 'updateOne', record('rounds.updateOne'));
	t.mock.method(models.gameMarks, 'findOne', () => ({ lean : async () => null }));
	t.mock.method(models.gameMarks, 'create', record('gameMarks.create'));
	t.mock.method(models, 'nextId', async () => 77);
	t.mock.method(models.bets, 'bulkWrite', record('bets.bulkWrite'));
	t.mock.method(models.users, 'bulkWrite', record('users.bulkWrite'));

	const user = (id, integration_type) => ({
		_id : id, user_id : `p${id}`, user_name : `P${id}`, vendor_id : id, money : 1000, user_type : 'C',
		currency : 'USD', denomination : 1, vendor : { _id : id, integration_type, currency : 'USD', multiplier : 1 }
	});
	const bets = [
		{ _id : 1, user_id : 1, type : 'r', bet_history : bet(), user : user(1, 'transfer'), created_at : new Date() },
		{ _id : 2, user_id : 2, type : 'r', bet_history : bet(), user : user(2, 'seamless'), created_at : new Date() },
		// folded: no flop bet
		{ _id : 3, user_id : 4, type : 'r', bet_history : bet({ flop : { bet : 0 }, turn : { bet : 0 }, river : { bet : 0 } }), user : user(4, 'transfer'), created_at : new Date() }
	];
	const original = _.cloneDeep(bets[0].bet_history);

	const settle = { roundId : 9, finalResult : { game_result : { winner : 'player' }, status : 'E' }, mark : { mark : 'P' } };
	const result = { tableId : 1, roundNum : 5, created_at : new Date(), updated_at : new Date(), gameInfo : {}, gameResult : {} };

	const out = await services.processBets(5, 1, 'player', bets, 30, 30, 0, 0, result, 'Anna', settle);

	assert.equal(out.roundWins, 245 + 245 + 0);
	assert.deepEqual(out.userInfo.map(u => u.total_winning), [245, 245, 0]);
	assert.deepEqual(out.userInfo.map(u => u.money), [1245, 1245, 1000]);
	assert.deepEqual(bets[0].bet_history, original, 'source bet history is not mutated');

	// round flipped P -> E guarded by status
	const [filter, update] = calls['rounds.updateOne'][0];
	assert.deepEqual(filter, { _id : 9, table_id : 1, round_num : 5, status : 'P' });
	assert.equal(update.$set.status, 'E');

	assert.deepEqual(calls['gameMarks.create'][0][0][0], { _id : 77, mark : [{ mark : 'P' }], mark_num : null, table_id : 1, round_id : 9 });

	const betOps = calls['bets.bulkWrite'][0][0];
	assert.equal(betOps.length, 3);
	assert.equal(betOps[2].updateOne.update.$set.total_lost, 15); // ante 10 + bonus 5 (a fold also forfeits the bonus)
	assert.equal(betOps[2].updateOne.update.$set.total_win, 0);
	assert.equal(betOps[2].updateOne.update.$set.bet_history.bonus.win, 0);

	// only the transfer user that won gets money
	assert.deepEqual(calls['users.bulkWrite'][0][0], [{ updateOne : { filter : { _id : 1 }, update : { $inc : { money : 245 } } } }]);
});

test('processBets: aborts when a bet changed after it was read (street bet during resulting)', async t => {
	t.mock.method(models, 'withTransaction', async fn => fn('session'));
	t.mock.method(models.rounds, 'updateOne', async () => ({ matchedCount : 1 }));
	t.mock.method(models.gameMarks, 'findOne', () => ({ lean : async () => ({ _id : 1 }) }));
	t.mock.method(models.gameMarks, 'updateOne', async () => ({}));
	const bulk = t.mock.method(models.bets, 'bulkWrite', async () => ({ matchedCount : 0 }));
	const users = t.mock.method(models.users, 'bulkWrite', async () => null);

	const updatedAt = new Date('2026-01-01T00:00:00Z');
	const bets = [{
		_id : 1, user_id : 1, type : 'r', bet_history : bet(), created_at : new Date(), updated_at : updatedAt,
		user : { _id : 1, money : 1000, vendor : { integration_type : 'transfer' } }
	}];
	const settle = { roundId : 9, finalResult : { game_result : {}, status : 'E' }, mark : { mark : 'P' } };
	const result = { created_at : new Date(), updated_at : new Date() };

	await assert.rejects(services.processBets(5, 1, 'player', bets, 30, 30, 0, 0, result, 'Anna', settle), /bets changed/);
	assert.deepEqual(bulk.mock.calls[0].arguments[0][0].updateOne.filter, { _id : 1, updated_at : updatedAt });
	assert.equal(users.mock.callCount(), 0, 'nobody is paid');
});

test('processBets: refuses a round that is not in progress', async t => {
	t.mock.method(models, 'withTransaction', async fn => fn('session'));
	t.mock.method(models.rounds, 'updateOne', async () => ({ matchedCount : 0 }));
	const users = t.mock.method(models.users, 'bulkWrite', async () => null);

	await assert.rejects(services.processBets(5, 1, 'player', [], 0, 0, 0, 0,
		{ created_at : new Date(), updated_at : new Date() }, null,
		{ roundId : 9, finalResult : { status : 'E' }, mark : { mark : 'P' } }), /not in progress/);
	assert.equal(users.mock.callCount(), 0);
});
