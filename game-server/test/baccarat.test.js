'use strict';

/*
 | Unit tests for the pure baccarat logic (no database / redis needed):
 | result computation (services.fnComputeResult) and payouts
 | (betsCalculator.fnSettle / evaluators).
 */

const { describe, it } = require('node:test');
const assert   = require('node:assert/strict');
const services = require('../src/games/baccarat/services');
const calc     = require('../src/games/baccarat/betsCalculator');

const CARD = {
	// club A..K = 0000..0012, heart = +13, diamond = +26, spade = +39
	c : n => String(n - 1).padStart(4, '0'),
	h : n => String(n + 12).padStart(4, '0'),
	d : n => String(n + 25).padStart(4, '0'),
	s : n => String(n + 38).padStart(4, '0')
};

const round = (game_info) => ({ round_num : 7, table_id : 1, game_info, created_at : new Date(), updated_at : new Date() });

const hand = (p1, p2, b1, b2, p3 = null, b3 = null) =>
	services.fnComputeResult(round({ banker1 : b1, banker2 : b2, banker3 : b3, player1 : p1, player2 : p2, player3 : p3 }));

const bet = (id, userId, type, history, integration = 'transfer') => ({
	id, user_id : userId, type,
	bet_history : history.map(([b, m]) => ({ bet : `bet_${b}`, bet_money : m })),
	user : { id : userId, money : 1000, user_type : 'C', vendor : { integration_type : integration } }
});

describe('fnComputeResult', () => {
	it('natural player win with player pair', () => {
		const r = hand(CARD.c(4), CARD.h(4), CARD.c(2), CARD.c(13));
		assert.equal(r.player.total, 8);
		assert.equal(r.banker.total, 2);
		assert.equal(r.winner, 'player');
		assert.deepEqual(r.pairs, ['player']);
		assert.deepEqual(r.natural, ['player']);
		assert.equal(r.supersix, false);
		assert.deepEqual(r.bonus, { type : 'natural_player', diff : 'bonus_6' });
		assert.equal(r.size, 'small');
		assert.equal(r.round_no, 7);
		assert.equal(r.table, 1);
	});

	it('banker wins with 6 on three cards (supersix, big, no natural)', () => {
		// player 3 + 2 + 10 = 5 ; banker 10 + 3 + 3 = 6
		const r = hand(CARD.c(3), CARD.c(2), CARD.s(10), CARD.d(3), CARD.h(12), CARD.h(3));
		assert.equal(r.player.total, 5);
		assert.equal(r.banker.total, 6);
		assert.equal(r.winner, 'banker');
		assert.equal(r.supersix, true);
		assert.equal(r.size, 'big');
		assert.deepEqual(r.natural, []);
		assert.deepEqual(r.bonus, { type : null, diff : 'bonus_1' });
		// a pair only counts on the first two cards
		assert.deepEqual(r.pairs, []);
	});

	it('tie with both pairs', () => {
		const r = hand(CARD.c(7), CARD.h(7), CARD.d(2), CARD.s(2), CARD.c(13), CARD.c(10));
		assert.equal(r.player.total, 4);
		assert.equal(r.banker.total, 4);
		assert.equal(r.winner, 'tie');
		assert.deepEqual(r.pairs, ['banker', 'player']);
		assert.equal(r.bonus.diff, null);
	});

	it('third card order follows the slot, not the stored key order', () => {
		const r = services.fnComputeResult(round({ player3 : CARD.c(2), player1 : CARD.c(5), banker1 : CARD.c(1), player2 : CARD.h(5), banker2 : CARD.c(9) }));
		assert.deepEqual(r.player.cards.map(c => c.id), [CARD.c(5), CARD.h(5), CARD.c(2)]);
		assert.deepEqual(r.pairs, ['player']);
	});
});

describe('road map mark', () => {
	it('maps winner + pairs', () => {
		assert.equal(calc.fnGetCardSideBetMark('banker', []), 'b');
		assert.equal(calc.fnGetCardSideBetMark('player', ['player']), 'h');
		assert.equal(calc.fnGetCardSideBetMark('tie', ['banker', 'player']), 'j');
		assert.equal(calc.fnGetCardSideBetMark('banker', ['banker', 'player']), 'w');
	});
});

describe('fnSettle / evaluators', () => {
	it('normal table: player win, player pair, banker loses', () => {
		const result = hand(CARD.c(4), CARD.h(4), CARD.c(2), CARD.c(13));
		const s = calc.fnSettle(result, [
			bet(1, 1, 'r', [['player', 100], ['playerpair', 10], ['banker', 50]]),
			bet(2, 3, 'r', [['player', 40]], 'seamless')
		]);
		const [b1, b2] = s.data;
		assert.equal(b1.total_bet, 160);
		assert.equal(b1.total_winning, 210);   // 100 + 11 * 10
		assert.equal(b1.total_win, 320);       // winnings + returned stakes
		assert.equal(b1.total_lost, 50);
		assert.equal(b1.bet_history[0].win_money, 200);
		assert.equal(b1.bet_history[1].win_money, 120);
		assert.equal(b2.total_win, 80);
		assert.equal(s.roundWins, 250);
		assert.equal(s.roundBets, 200);
		// only the transfer wallet is credited
		assert.deepEqual(s.moneyByUser, { 1 : 320 });
		assert.equal(s.userInfo[0].money, 1320);
		assert.equal(s.oddsbonus, null);
	});

	it('banker pays 0.95', () => {
		const result = hand(CARD.c(2), CARD.c(3), CARD.c(9), CARD.c(13));
		const s = calc.fnSettle(result, [bet(1, 1, 'r', [['banker', 100]])]);
		assert.equal(result.winner, 'banker');
		assert.equal(s.data[0].total_winning, 95);
		assert.equal(s.data[0].total_win, 195);
	});

	it('tie returns player / banker stakes and pays tie 8:1', () => {
		const result = hand(CARD.c(7), CARD.h(7), CARD.d(2), CARD.s(2), CARD.c(13), CARD.c(10));
		const s = calc.fnSettle(result, [bet(1, 1, 'r', [['tie', 10], ['banker', 100]])]);
		const b = s.data[0];
		assert.equal(b.total_win, 90 + 100);
		assert.equal(b.total_rolling, 10);   // returned stakes are not rolling
		assert.equal(b.total_lost, 0);
		assert.equal(b.bet_history[1].win_money, 100);
	});

	it('supersix table: banker 6 pays half, supersix pays 12:1', () => {
		const result = hand(CARD.c(3), CARD.c(2), CARD.s(10), CARD.d(3), CARD.h(12), CARD.h(3));
		const s = calc.fnSettle(result, [bet(1, 1, 's', [['banker', 100], ['supersix', 10]])]);
		const b = s.data[0];
		assert.equal(b.bet_history[0].win_money, 150);
		assert.equal(b.bet_history[1].win_money, 130);
		assert.equal(b.total_winning, 50 + 120);
		assert.equal(b.total_win, 150 + 130);
	});

	it('bonus table: natural bonus odds and big/small', () => {
		const result = hand(CARD.c(4), CARD.h(4), CARD.c(2), CARD.c(13));
		const s = calc.fnSettle(result, [bet(1, 1, 'b', [['bonus_player', 10], ['bonus_banker', 10], ['small', 20]])]);
		const b = s.data[0];
		assert.equal(b.bet_history[0].win_money, 20);   // natural_player 2:1, stake not added
		assert.equal(b.bet_history[1].win_money, undefined);
		assert.equal(b.bet_history[2].win_money, 50);   // small 1.5 + stake
		assert.equal(b.total_win, 20 + 50);
		assert.equal(b.total_lost, 10);
		assert.equal(s.oddsbonus, 2);
	});

	it('oddsbonus does not leak into the next round', () => {
		const natural = hand(CARD.c(4), CARD.h(4), CARD.c(2), CARD.c(13));
		assert.equal(calc.fnSettle(natural, [bet(1, 1, 'b', [['bonus_player', 10]])]).oddsbonus, 2);
		const other = hand(CARD.c(2), CARD.c(3), CARD.c(9), CARD.c(13));
		assert.equal(calc.fnSettle(other, [bet(1, 1, 'r', [['banker', 10]])]).oddsbonus, null);
	});

	it('credits all bets of a user', () => {
		const result = hand(CARD.c(4), CARD.h(4), CARD.c(2), CARD.c(13));
		const s = calc.fnSettle(result, [bet(1, 1, 'r', [['player', 10]]), bet(2, 1, 'r', [['player', 20]])]);
		assert.deepEqual(s.moneyByUser, { 1 : 60 });
	});

	it('rejects unsupported bet types', () => {
		const result = hand(CARD.c(4), CARD.h(4), CARD.c(2), CARD.c(13));
		assert.throws(() => calc.fnSettle(result, [bet(1, 1, 'i', [['player', 10]])]), /unsupported bet type/);
	});
});
