/*
 |--------------------------------------------------------------------------
 | round text
 |--------------------------------------------------------------------------
 | How a round reads in the admin: status, cards and result. Pure, covered by
 | test/roundText.test.ts.
 |
 | Card codes are the scanner's 0000-0051: suit club, heart, diamond, spade
 | (13 each), rank A..K.
 |
 */

import type { Game } from './config.ts';

export const STATUS_LABELS: Record<string, string> = {
	S : 'Betting',
	P : 'Dealing',
	H : 'On hold',
	E : 'Successful',
	C : 'Cancelled',
	V : 'Voided'
};

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♣', '♥', '♦', '♠'];

export function cardName (code: unknown): string {
	const text = String(code ?? '');
	if (!/^\d{1,4}$/.test(text)) return text;
	const n = Number(text);
	return n >= 0 && n < 52 ? RANKS[n % 13] + SUITS[Math.floor(n / 13)] : text;
}

const cards = (list: unknown) => (Array.isArray(list) ? list : [list]).filter(c => c !== null && c !== undefined && c !== '').map(cardName).join(' ');

const cap = (s: unknown) => {
	const text = String(s ?? '').replace(/_/g, ' ');
	return text ? text[0].toUpperCase() + text.slice(1) : '';
};

/** "Banker" / "Dragon" / "Player wins · Straight", or '' without a result */
export function resultText (game: Game, result: any): string {
	if (!result || !result.winner) return '';
	if (game === 'poker') return `${cap(result.winner)} wins${result.handtype ? ` · ${result.handtype}` : ''}`;
	if (game === 'baccarat') {
		const pairs = Array.isArray(result.pairs) && result.pairs.length ? ` · ${result.pairs.map(cap).join(', ')}` : '';
		return `${cap(result.winner)}${pairs}${result.supersix ? ' · Super 6' : ''}`;
	}
	return cap(result.winner);
}

/** the dealt cards: "P 5♥ 9♣ · B K♠ 2♦ 7♣" */
export function cardsText (game: Game, info: any): string {
	if (!info) return '';
	const parts: string[] = [];
	const add = (label: string, list: unknown) => {
		const text = cards(list);
		if (text) parts.push(`${label} ${text}`);
	};
	if (game === 'baccarat') {
		add('P', [info.player1, info.player2, info.player3]);
		add('B', [info.banker1, info.banker2, info.banker3]);
	} else if (game === 'dragontiger') {
		add('D', info.dragon);
		add('T', info.tiger);
	} else {
		add('Player', info.player);
		add('Dealer', info.dealer);
		add('Board', [...(info.flop || []), info.turn, info.river]);
	}
	return parts.join(' · ');
}
