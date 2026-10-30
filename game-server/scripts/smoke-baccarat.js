'use strict';

/*
 |--------------------------------------------------------------------------
 | smoke-baccarat
 |--------------------------------------------------------------------------
 | Plays one full round against a running baccarat game server, acting as
 | the dealer page, and checks acks, published events and the database.
 | Needs the same env as the server (MONGO_URI, MONGO_SHARED_DB,
 | BACCARAT_DB, REDIS_*, BACCARAT_PORT) and seeded data (npm run seed).
 |
 |   node scripts/smoke-baccarat.js [tableId]
 |
 */

require('../src/core/console');
const assert = require('node:assert/strict');
const Redis  = require('ioredis');
const { io } = require('socket.io-client');
const conf   = require('../src/config');
const core   = require('../src/core/models');

const game    = conf.games.baccarat;
const tableId = parseInt(process.argv[2] || 1);
const models  = core.forGame('baccarat');

const published = [];
const waiters   = [];

const step = (name) => console.log(`- ${name}`.info);

function waitForEvent (eventName, timeoutMs = 5000) {
	const found = published.find(m => m.eventName === eventName && !m.seen);
	if (found) {
		found.seen = true;
		return Promise.resolve(found);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no "${eventName}" published`)), timeoutMs);
		waiters.push({ eventName, resolve : m => { clearTimeout(timer); m.seen = true; resolve(m); } });
	});
}

async function main () {
	await core.connect();

	const sub = new Redis({ host : conf.redis.host, port : conf.redis.port, password : conf.redis.password });
	await sub.subscribe('game-servers');
	sub.on('message', (channel, message) => {
		const data = JSON.parse(message);
		if (data.gameName !== game.gameName || data.tableId !== tableId) return;
		const i = waiters.findIndex(w => w.eventName === data.eventName);
		if (i > -1) waiters.splice(i, 1)[0].resolve(data);
		else published.push(data);
	});

	const socket = io(`http://127.0.0.1:${game.port}`, { transports : ['websocket'], reconnection : false });
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('connect_error', reject);
	});
	const push = (event, data) => socket.timeout(5000).emitWithAck('push', { event, data });

	try {
		step('checkifdealer');
		assert.equal(await push('checkifdealer', 'D0001'), 'dealer');
		assert.equal(await push('checkifdealer', 'AA123456'), 'shoe');
		assert.equal(await push('checkifdealer', '0051'), 'card');
		assert.equal(await push('checkifdealer', 'nope'), 'error');
		assert.equal(await push('checkifdealer', { $ne : null }), 'error');

		step('gettables');
		const tables = await push('gettables');
		assert.equal(tables.eventName, 'init');
		assert.ok(tables.tables.includes(tableId));

		step('init');
		let row = await push('init', tableId);
		assert.ok(row, 'init failed');
		assert.equal(row.table, tableId);
		assert.ok(row.dealer && row.dealer.id, 'init without dealer');
		assert.equal(typeof row.roundId, 'number');

		step('new shoe');
		const shoeCode = `AA${String(Date.now()).slice(-6)}`;
		assert.equal(await push('inputitem', { from : 'shoe', value : shoeCode }), 'shoe changed');
		await waitForEvent('shoechange');
		const shoe = await models.gameMarks.findOne({ table_id : tableId }).sort({ _id : -1 }).lean();
		assert.equal(shoe.mark_num, shoeCode);
		assert.deepEqual(shoe.mark, []);

		step('newround');
		const round = await push('newround', { roundNum : row.roundNum });
		assert.equal(round.round_num, row.roundNum + 1);
		assert.equal(typeof round.id, 'number');
		const newRound = await waitForEvent('newround');
		assert.equal(newRound.roundId, round.id);
		assert.equal(newRound.status, 'S');
		assert.equal(newRound.bettimer, 15);

		step('dealer change');
		const change = await push('inputitem', { from : 'dealer_id', value : 'D0002' });
		assert.equal(change.eventName, 'dealerchange');
		assert.equal(change.dealerId, 2);
		await waitForEvent('dealerchange');
		assert.equal((await models.rounds.findById(round.id).lean()).dealer_id, 2);
		assert.equal((await models.dealers.findById(2).lean()).table_name, `${game.gameName}# ${tableId}`);

		step('card before setroundprogress is refused');
		assert.equal(await push('inputitem', { from : 'player1', value : '0003' }), 'roundStatusError');

		step('bets for user 1 (transfer) and user 3 (seamless)');
		const [user1, user3] = await Promise.all([models.users.findById(1).lean(), models.users.findById(3).lean()]);
		const betIds = [await models.nextId('bets'), await models.nextId('bets')];
		await models.bets.insertMany([
			{ _id : betIds[0], round_id : round.id, user_id : 1, type : 'r', total_bet : 110, bet_range : '10-1000', currency : 'USD',
				bet_history : [{ bet : 'bet_player', bet_money : 100 }, { bet : 'bet_playerpair', bet_money : 10 }] },
			{ _id : betIds[1], round_id : round.id, user_id : 3, type : 'r', total_bet : 250, bet_range : '10-1000', currency : 'USD',
				bet_history : [{ bet : 'bet_player', bet_money : 50 }, { bet : 'bet_banker', bet_money : 200 }] }
		]);

		step('setroundprogress / stoptimer / setbettingtime');
		assert.equal(await push('setroundprogress'), 'P');
		assert.equal((await waitForEvent('setroundprogress')).status, 'P');
		assert.equal(await push('stoptimer'), true);
		await waitForEvent('stoptimer');
		assert.equal(await push('setbettingtime', { betTime : '20', totalTime : '25' }), true);
		const bt = await waitForEvent('setbettingtime');
		assert.equal(bt.bettingTime, 20);
		assert.equal(bt.totalTime, 25);

		step('inputitem + removeitem');
		row = await push('inputitem', { from : 'player1', value : '0050' });
		assert.equal(row.gameInfo.player1, '0050');
		assert.equal((await waitForEvent('inputitem')).gameInfo.player1, '0050');
		row = await push('removeitem');
		assert.equal(row.gameInfo.player1, null);
		assert.equal((await waitForEvent('removeitem')).gameInfo.player1, null);

		// player 4+4 = 8 (natural, player pair) vs banker 2+K = 2
		for (const [from, value] of [['player1', '0003'], ['banker1', '0001'], ['player2', '0016'], ['banker2', '0012']]) {
			row = await push('inputitem', { from, value });
			assert.equal(row.gameInfo[from], value);
			const pub = await waitForEvent('inputitem');
			assert.equal(pub.type, from);
			assert.equal(pub.gameInfo[from], value);
		}

		step('displayresults');
		const result = await push('displayresults');
		assert.ok(result, 'displayresults failed');
		assert.equal(result.winner, 'player');
		assert.deepEqual(result.pairs, ['player']);
		assert.deepEqual(result.natural, ['player']);
		assert.equal(result.player.total, 8);
		assert.equal(result.banker.total, 2);

		const pub = await waitForEvent('displayresults');
		assert.equal(pub.roundId, round.id);
		assert.equal(pub.status, 'E');
		assert.equal(pub.dealerName, 'Bella');
		assert.deepEqual(pub.gameResult.pairs, ['player']);
		assert.deepEqual(pub.mark, { num : 8, mark : 'h', natural : ['player'] });
		// user 1: player 100 -> 100, player pair 10 -> 110; user 3: player 50 -> 50
		assert.equal(pub.totalWinning, 260);
		const info1 = pub.userInfo.find(u => u.id === 1);
		const info3 = pub.userInfo.find(u => u.id === 3);
		assert.equal(info1.total_winning, 320);
		assert.equal(info3.total_winning, 100);
		assert.equal(info3.total_lost, 200);
		assert.equal(pub.regionalResult.bets.length, 2);
		assert.equal(pub.regionalResult.bets[0].id, betIds[0]);

		step('database after settlement');
		const ended = await models.rounds.findById(round.id).lean();
		assert.equal(ended.status, 'E');
		assert.equal(ended.game_result.winner, 'player');
		const [bet1, bet3] = await Promise.all(betIds.map(id => models.bets.findById(id).lean()));
		assert.equal(bet1.total_win, 320);
		assert.equal(bet1.total_winning, 210);
		assert.equal(bet1.total_lost, 0);
		assert.equal(bet1.bet_history[1].win_money, 120);
		assert.equal(bet3.total_win, 100);
		assert.equal(bet3.total_lost, 200);
		const [after1, after3] = await Promise.all([models.users.findById(1).lean(), models.users.findById(3).lean()]);
		assert.equal(after1.money, user1.money + 320, 'transfer user credited');
		assert.equal(after3.money, user3.money, 'seamless user untouched');
		const marks = await models.gameMarks.findById(shoe._id).lean();
		assert.deepEqual(marks.mark, [{ natural : ['player'], num : 8, mark : 'h' }]);

		step('second displayresults is refused (no double payout)');
		assert.equal(await push('displayresults'), false);
		assert.equal((await models.users.findById(1).lean()).money, after1.money);
		assert.equal((await models.gameMarks.findById(shoe._id).lean()).mark.length, 1);

		step('autonextround toggles');
		assert.equal(await push('autonextround'), 5);
		assert.equal(await push('autonextround'), 0);

		console.log('smoke-baccarat: PASS'.info);
	} finally {
		socket.close();
		await sub.quit();
		await core.disconnect();
	}
}

main().catch(e => {
	console.log('smoke-baccarat: FAIL'.error, e);
	process.exit(1);
});
