'use strict';

/*
 | Dragon-Tiger result / payout logic (no database needed).
 |   node --test test/dragontiger.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const deck           = require('../src/games/dragontiger/cardsModule');
const services       = require('../src/games/dragontiger/services');
const betsCalculator = require('../src/games/dragontiger/betsCalculator');

// card ids: suit offset (club 0, heart 13, diamond 26, spade 39) + value - 1
const SUITS = { club : 0, heart : 13, diamond : 26, spade : 39 };
const card  = (suit, value) => String(SUITS[suit] + value - 1).padStart(4, '0');

const round = (dragon, tiger, extra = {}) => Object.assign({
	_id        : 10,
	table_id   : 1,
	round_num  : 5,
	status     : 'P',
	created_at : new Date('2026-01-01T00:00:00Z'),
	updated_at : new Date('2026-01-01T00:00:30Z'),
	game_info  : { burn : card('club', 2), dragon, tiger },
	bets       : []
}, extra);

const resultOf = (dragon, tiger) => services.fnBuildResult(round(dragon, tiger)).result;

const user = (id, integration_type) => ({
	id, vendor_id : id, user_id : `player${id}`, user_name : `P${id}`, money : 1000, user_type : 'C',
	currency : 'USD', denomination : 1,
	vendor : { id, type : 'casino', integration_type, currency : 'USD', multiplier : 1 }
});

const bet = (id, u, history) => ({
	id, round_id : 10, type : 'r', user_id : u.id, created_at : new Date(), bet_range : '10-1000',
	bet_id : `b${id}`, session_id : 's', currency : 'USD', user : u,
	bet_history : history.map(([name, money]) => ({ bet : name, bet_money : money }))
});

describe('cardsModule', () => {
	test('decodes value, suit, parity and size', () => {
		assert.deepEqual(
			(({ value, suite, parity, size }) => ({ value, suite, parity, size }))(deck('0025')),
			{ value : 13, suite : 'heart', parity : 'odd', size : 'big' }
		);
		assert.equal(deck(card('spade', 4)).parity, 'even');
		assert.equal(deck(card('spade', 4)).size, 'small');
	});

	test('a seven is neither odd/even nor big/small', () => {
		assert.equal(deck(card('club', 7)).parity, 'seven');
		assert.equal(deck(card('club', 7)).size, 'seven');
	});

	test('checkCard only accepts the 52 card ids', () => {
		assert.ok(deck().checkCard('0000'));
		assert.ok(deck().checkCard('0051'));
		assert.ok(!deck().checkCard('0052'));
		assert.ok(!deck().checkCard('constructor'));
		assert.ok(!deck().checkCard('D0001'));
	});
});

describe('services.fnBuildResult', () => {
	test('higher card wins', () => {
		assert.equal(resultOf(card('heart', 13), card('club', 4)).winner, 'dragon');
		assert.equal(resultOf(card('heart', 1), card('club', 2)).winner, 'tiger');
	});

	test('ties: suited tie only with the same suit and not on sevens', () => {
		assert.equal(resultOf(card('heart', 9), card('club', 9)).winner, 'tie');
		assert.equal(resultOf(card('heart', 9), card('heart', 9)).winner, 'suited tie');
		assert.equal(resultOf(card('heart', 7), card('heart', 7)).winner, 'tie');
	});

	test('game_result side bets, sevens become "seven"', () => {
		const { gameResult, roundStatus } = services.fnBuildResult(round(card('diamond', 7), card('spade', 12)));
		assert.equal(roundStatus, 'P');
		assert.deepEqual(gameResult, {
			game_result : {
				winner    : 'tiger',
				side_bets : {
					dragon : 'seven',
					tiger  : { suite : 'spade', size : 'big', parity : 'even' }
				}
			},
			status : 'E'
		});
	});

	test('refuses rounds that cannot be resulted', () => {
		assert.throws(() => services.fnBuildResult(round('0001', '0002', { status : 'E' })), { message : 'result already sent' });
		assert.throws(() => services.fnBuildResult(round('0001', '0002', { status : 'S' })), { message : 'status not in progress' });
		assert.throws(() => services.fnBuildResult(round('0001', null)), { message : 'not enough cards' });
		assert.throws(() => services.fnBuildResult(round('0001', 'XXXX')), { message : 'missing values' });
		// a held round with both cards can still be resulted
		assert.equal(services.fnBuildResult(round('0001', '0002', { status : 'H' })).roundStatus, 'H');
	});
});

describe('road map marks', () => {
	const sizes = [['Big', 'Big', '11'], ['Big', 'Small', '10'], ['Small', 'Big', '01'], ['Small', 'Small', '00']];
	const infoMarks = [];
	['Dragon', 'Tiger', 'Tie', 'Suited Tie'].forEach((w, i) => sizes.forEach(([d, t], j) => infoMarks.push({
		mark : 'abcdefghijklmnop'[i * 4 + j], mark_info : `${w} - Dragon ${d} Tiger ${t}`
	})));
	const h = services.fnParseMarks(infoMarks.concat({ mark : 'z', mark_info : 'no separator' }));

	test('fnParseMarks keys marks by winner and dragon/tiger size', () => {
		assert.equal(Object.keys(h).length, 16);
		assert.equal(h['dragon.11'], 'a');
		assert.equal(h['tiger.01'], 'g');
		assert.equal(h['tie.00'], 'l');
		assert.equal(h['suited tie.10'], 'n');
	});

	test('fnGetCardSideBetMark', () => {
		assert.equal(betsCalculator.fnGetCardSideBetMark('dragon', 13, 13, 4, h), 'b');
		assert.equal(betsCalculator.fnGetCardSideBetMark('tiger', 9, 2, 9, h), 'g');
		assert.equal(betsCalculator.fnGetCardSideBetMark('suited tie', 9, 9, 9, h), 'm');
		// seven is "small" and a suited seven counts as a plain tie
		assert.equal(betsCalculator.fnGetCardSideBetMark('suited tie', 7, 7, 7, h), 'l');
	});
});

describe('betsCalculator payouts', () => {
	const pay = (name, dragon, tiger, amount = 100) => betsCalculator[name](resultOf(dragon, tiger), amount);

	test('main bets pay 1:1', () => {
		assert.equal(pay('dragon', card('heart', 13), card('club', 4)), 100);
		assert.equal(pay('tiger', card('heart', 13), card('club', 4)), 0);
		assert.equal(pay('tiger', card('heart', 2), card('club', 4)), 100);
		assert.equal(pay('dragon', card('heart', 2), card('club', 2)), 0);
	});

	test('tie pays 10:1, suited tie 50:1 (10:1 on sevens)', () => {
		assert.equal(pay('tie', card('heart', 5), card('club', 5)), 1000);
		assert.equal(pay('tie', card('heart', 5), card('heart', 5)), 1000);
		assert.equal(pay('suited_tie', card('heart', 5), card('heart', 5)), 5000);
		assert.equal(pay('suited_tie', card('heart', 5), card('club', 5)), 0);
		assert.equal(pay('tie', card('heart', 3), card('club', 5)), 0);
	});

	test('side bets: size, parity 1:1, suit 3:1, all lose on a seven', () => {
		const d = card('heart', 8);
		const t = card('spade', 3);
		assert.equal(pay('dragon_big', d, t), 100);
		assert.equal(pay('dragon_small', d, t), 0);
		assert.equal(pay('dragon_even', d, t), 100);
		assert.equal(pay('dragon_odd', d, t), 0);
		assert.equal(pay('dragon_hearts', d, t), 300);
		assert.equal(pay('dragon_spades', d, t), 0);
		assert.equal(pay('tiger_small', d, t), 100);
		assert.equal(pay('tiger_odd', d, t), 100);
		assert.equal(pay('tiger_spades', d, t), 300);
		assert.equal(pay('tiger_clubs', d, t), 0);

		const seven = card('diamond', 7);
		for (const name of ['big', 'small', 'odd', 'even', 'clubs', 'hearts', 'diamonds', 'spades']) {
			assert.equal(pay(`dragon_${name}`, seven, t), 0, `dragon_${name}`);
			assert.equal(pay(`tiger_${name}`, d, seven), 0, `tiger_${name}`);
		}
	});
});

describe('betsCalculator.fnSettle', () => {
	test('settles each bet and only credits transfer users', () => {
		const result = resultOf(card('heart', 13), card('heart', 4));
		const transfer = user(1, 'transfer');
		const seamless = user(3, 'seamless');
		const s = betsCalculator.fnSettle(result, [
			bet(11, transfer, [['dragon', 100], ['dragon_big', 50], ['tie', 10]]),
			bet(12, seamless, [['tiger', 100], ['tiger_hearts', 20]])
		]);

		assert.equal(s.roundWins, 380);
		assert.deepEqual(s.betUpdates.map(b => [b.id, b.set.total_bet, b.set.total_winning, b.set.total_win, b.set.total_lost, b.set.total_rolling]), [
			[11, 160, 150, 300, 10, 160],
			[12, 120, 60, 80, 100, 120]
		]);
		assert.deepEqual(s.betUpdates[0].set.bet_history.map(b => b.win_money), [200, 100, undefined]);
		assert.deepEqual(s.moneyIncs, [{ userId : 1, amount : 300 }]);
		assert.deepEqual(s.userInfo.map(u => [u.id, u.money, u.total_winning, u.total_lost]), [[1, 1300, 300, 10], [3, 1080, 80, 100]]);
		assert.equal(s.apiUserInfo[1].total_win, 80);
		assert.equal(s.apiUserInfo[1].multiplier, 1);
	});

	test('on a tie half of the main bets is returned', () => {
		const result = resultOf(card('heart', 9), card('club', 9));
		const s = betsCalculator.fnSettle(result, [bet(1, user(1, 'transfer'), [['dragon', 100], ['tie', 10]])]);

		// tie wins 10 * 10 (+10 stake back), the dragon bet gets 50 back
		assert.deepEqual(s.betUpdates[0].set.bet_history.map(b => b.win_money), [50, 110]);
		assert.equal(s.betUpdates[0].set.total_winning, 150);
		assert.equal(s.betUpdates[0].set.total_win, 160);
		assert.equal(s.betUpdates[0].set.total_lost, 50);
		assert.equal(s.betUpdates[0].set.total_rolling, 60);
	});

	test('does not mutate the stored bet history', () => {
		const b = bet(1, user(1, 'transfer'), [['dragon', 100]]);
		betsCalculator.fnSettle(resultOf(card('heart', 13), card('club', 4)), [b]);
		assert.equal(b.bet_history[0].win_money, undefined);
	});

	test('unknown bet names are rejected', () => {
		const result = resultOf(card('heart', 13), card('club', 4));
		assert.throws(() => betsCalculator.fnSettle(result, [bet(1, user(1, 'transfer'), [['processBets', 100]])]), /unknown bet/);
	});
});
