import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardName, cardsText, resultText } from '../src/lib/roundText.ts';

test('card codes: club, heart, diamond, spade; A..K', () => {
	assert.equal(cardName('0000'), 'A♣');
	assert.equal(cardName('0012'), 'K♣');
	assert.equal(cardName('0013'), 'A♥');
	assert.equal(cardName('0035'), '10♦');
	assert.equal(cardName('0051'), 'K♠');
	assert.equal(cardName('0052'), '0052');
	assert.equal(cardName('9H'), '9H');
});

test('cards per game, empty slots left out', () => {
	assert.equal(cardsText('baccarat', { player1 : '0017', player2 : '0040', player3 : null, banker1 : '0024', banker2 : '0015', banker3 : '0007' }), 'P 5♥ 2♠ · B Q♥ 3♥ 8♣');
	assert.equal(cardsText('dragontiger', { dragon : '0000', tiger : '0019', burn : '0045' }), 'D A♣ · T 7♥');
	assert.equal(cardsText('poker', { player : ['0011', '0048'], dealer : ['0034', '0002'], flop : ['0039', '0017', '0001'], turn : '0051', river : '0036' }),
		'Player Q♣ 10♠ · Dealer 9♦ 3♣ · Board A♠ 5♥ 2♣ K♠ J♦');
	assert.equal(cardsText('baccarat', null), '');
});

test('results', () => {
	assert.equal(resultText('baccarat', { winner : 'banker', pairs : ['player_pair'], supersix : false }), 'Banker · Player pair');
	assert.equal(resultText('dragontiger', { winner : 'suited tie' }), 'Suited tie');
	assert.equal(resultText('poker', { winner : 'player', handtype : 'Straight' }), 'Player wins · Straight');
	assert.equal(resultText('poker', null), '');
});
