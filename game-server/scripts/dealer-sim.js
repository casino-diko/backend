'use strict';

/*
 |--------------------------------------------------------------------------
 | dealer simulator
 |--------------------------------------------------------------------------
 | Plays endless rounds on every table of every game, like the dealer pages
 | (card scanners) would, so the stack can be tested by hand without real
 | dealers: new round -> betting countdown -> cards -> results -> pause.
 |
 |   npm run dealer                         (all games on localhost)
 |   DEALER_GAMES=baccarat BET_SECONDS=20 npm run dealer
 |
 | Env: DEALER_HOST (default 127.0.0.1), BACCARAT_PORT / DRAGONTIGER_PORT /
 | POKER_PORT, DEALER_GAMES, BET_SECONDS (15), STREET_SECONDS (poker
 | flop/turn/river decisions, 10), RESULT_SECONDS (pause after results, 8),
 | CARD_MS (pause between card scans, 1200).
 |
 */

require('../src/core/console');
const { io } = require('socket.io-client');
const conf = require('../src/config');

const env = process.env;
const HOST           = env.DEALER_HOST || '127.0.0.1';
const GAMES          = (env.DEALER_GAMES || 'baccarat,dragontiger,poker').split(',').map(g => g.trim()).filter(Boolean);
const BET_SECONDS    = parseInt(env.BET_SECONDS || 15);
const STREET_SECONDS = parseInt(env.STREET_SECONDS || 10);
const RESULT_SECONDS = parseInt(env.RESULT_SECONDS || 8);
const CARD_MS        = parseInt(env.CARD_MS || 1200);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const card  = () => String(Math.floor(Math.random() * 52)).padStart(4, '0');
const shuffledDeck = () => {
	const deck = Array.from({ length : 52 }, (v, i) => String(i).padStart(4, '0'));
	for (let i = deck.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
};

// codes 0000-0051: four suits of A..K
const baccaratValue = code => {
	const rank = parseInt(code) % 13;
	return rank < 9 ? rank + 1 : 0;
};

/** baccarat drawing rules -> [[slot, card], ...] in scanning order */
function baccaratHand () {
	const p = [card(), card()];
	const b = [card(), card()];
	const total = cards => cards.reduce((sum, c) => sum + baccaratValue(c), 0) % 10;
	const order = [['player1', p[0]], ['banker1', b[0]], ['player2', p[1]], ['banker2', b[1]]];

	const pt = total(p);
	const bt = total(b);
	if (pt >= 8 || bt >= 8) return order;

	let third = null;
	if (pt <= 5) {
		third = card();
		order.push(['player3', third]);
	}

	let bankerDraws;
	if (third === null) bankerDraws = bt <= 5;
	else {
		const v = baccaratValue(third);
		bankerDraws = bt <= 2 || (bt === 3 && v !== 8) || (bt === 4 && v >= 2 && v <= 7)
			|| (bt === 5 && v >= 4 && v <= 7) || (bt === 6 && (v === 6 || v === 7));
	}
	if (bankerDraws) order.push(['banker3', card()]);
	return order;
}

// per game: how its dealer page talks to the game server
const PROTOCOL = {
	baccarat : {
		init     : table => ({ event : 'init', data : table }),
		newround : roundNum => ({ event : 'newround', data : { roundNum } }),
		tick     : (left, total) => ({ event : 'setbettingtime', data : { betTime : left, totalTime : total } }),
		card     : (from, value) => ({ event : 'inputitem', data : { from, value } }),
		async deal (send) {
			for (const [from, value] of baccaratHand()) {
				await sleep(CARD_MS);
				await send(this.card(from, value));
			}
		}
	},
	dragontiger : {
		init     : table => ({ event : 'init', data : table }),
		newround : roundNum => ({ event : 'newround', roundNum }),
		tick     : (left, total) => ({ event : 'bettimer', data : left, totalTime : total }),
		card     : (from, value) => ({ event : 'inputitem', from, value }),
		async deal (send) {
			for (const from of ['dragon', 'tiger']) {
				await sleep(CARD_MS);
				await send(this.card(from, card()));
			}
		},
		// dragon-tiger takes the burn card while betting is still open
		beforeProgress : async function (send) {
			await send(this.card('burn', card()));
		}
	},
	poker : {
		init     : table => ({ event : 'init', data : table }),
		newround : roundNum => ({ event : 'newround', roundNum }),
		tick     : (left, total, type = 'startround') => ({ event : 'bettimer', data : left, countType : type, totalTime : total }),
		card     : (from, value) => ({ event : 'inputitem', from, data : value }),
		async deal (send, countdown) {
			const deck = shuffledDeck();
			const scan = async (...slots) => {
				for (const from of slots) {
					await sleep(CARD_MS);
					await send(this.card(from, deck.pop()));
				}
			};
			// players decide on each street while its timer runs (flop bet / fold, then turn, then river);
			// the dealer's hand is scanned last
			await scan('burn', 'player', 'player', 'burn', 'flop', 'flop', 'flop');
			await countdown(STREET_SECONDS, 'flop');
			await scan('burn', 'turn');
			await countdown(STREET_SECONDS, 'turn');
			await scan('river');
			await countdown(STREET_SECONDS, 'river');
			await scan('dealer', 'dealer');
		},
		// poker publishes the results only on passResult (the dealer page shows them first)
		afterResults : async send => send({ event : 'passResult' })
	}
};

class TableDealer {
	constructor (gameKey, tableId) {
		this.game     = conf.games[gameKey];
		this.protocol = PROTOCOL[gameKey];
		this.tableId  = tableId;
		this.name     = `${this.game.gameName} #${tableId}`;
		this.socket   = io(`http://${HOST}:${this.game.port}`, { transports : ['websocket'] });
	}

	log (msg, color = 'info') {
		console.log(`[${this.name}] ${msg}`[color]);
	}

	send (payload, timeout = 15000) {
		return this.socket.timeout(timeout).emitWithAck('push', payload);
	}

	async countdown (seconds, type) {
		for (let left = seconds; left >= 0; left--) {
			this.socket.emit('push', this.protocol.tick(left, seconds, type));
			if (left) await sleep(1000);
		}
	}

	async round () {
		const p = this.protocol;
		const row = await this.send(p.init(this.tableId));
		if (!row || row.error || row.roundNum === undefined) throw new Error(`init failed: ${JSON.stringify(row)}`);

		const started = await this.send(p.newround(row.roundNum));
		if (!started || started.error) throw new Error(`newround failed: ${JSON.stringify(started)}`);
		const roundNum = typeof started === 'object' ? started.round_num : started;
		this.log(`round ${roundNum}: betting open for ${BET_SECONDS}s`);

		await this.countdown(BET_SECONDS, 'startround');
		if (p.beforeProgress) await p.beforeProgress.call(p, payload => this.send(payload));
		await this.send({ event : 'stoptimer' });

		const progress = await this.send({ event : 'setroundprogress' });
		if (progress !== 'P') throw new Error(`setroundprogress refused: ${JSON.stringify(progress)}`);

		await p.deal.call(p, async payload => {
			const ack = await this.send(payload);
			if (ack === false || (ack && ack.error) || ack === 'roundStatusError') {
				throw new Error(`card refused: ${JSON.stringify(payload)} -> ${JSON.stringify(ack)}`);
			}
		}, (seconds, type) => this.countdown(seconds, type));

		await sleep(CARD_MS);
		const result = await this.send({ event : 'displayresults' }, 30000);
		if (!result || result.error) throw new Error(`displayresults failed: ${JSON.stringify(result)}`);
		if (p.afterResults) await p.afterResults(payload => this.send(payload));

		let winner = result.winSide || (result.gameResult && result.gameResult.winner) || result.winner
			|| (result.result && result.result.winner) || '';
		if (typeof winner === 'object') winner = winner.winner || winner.side || JSON.stringify(winner).slice(0, 60);
		this.log(`round ${roundNum}: resulted ${winner}`);
		await sleep(RESULT_SECONDS * 1000);
	}

	async run () {
		await new Promise(resolve => this.socket.once('connect', resolve));
		this.log('connected');
		for (;;) {
			try {
				await this.round();
			} catch (e) {
				this.log(`${e.message} - retrying in 5s`, 'error');
				await sleep(5000);
			}
		}
	}
}

async function main () {
	for (const key of GAMES) {
		if (!PROTOCOL[key]) throw new Error(`unknown game ${key}`);
		const probe = io(`http://${HOST}:${conf.games[key].port}`, { transports : ['websocket'] });
		const tables = await probe.timeout(10000).emitWithAck('push', { event : 'gettables' })
			.finally(() => probe.close());
		const ids = (tables && tables.tables) || [];
		console.log(`${conf.games[key].gameName}: tables ${ids.join(', ') || '(none - run the seed)'}`.verbose);
		for (const id of ids) new TableDealer(key, id).run();
	}
}

main().catch(e => {
	console.log('dealer simulator failed:'.error, e.message);
	process.exit(1);
});
