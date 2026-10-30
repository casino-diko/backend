'use strict';

/*
 |--------------------------------------------------------------------------
 | poker smoke test
 |--------------------------------------------------------------------------
 | Starts the game server (GAMES=poker), acts as the dealer page over
 | socket.io and checks acks, redis payloads and the database end to end:
 | init -> newround -> bets -> progress -> cards -> results -> settlement.
 |
 |   npm run seed && node scripts/smoke-poker.js
 |
 | Uses the same env as the server (MONGO_URI, MONGO_SHARED_DB, POKER_DB,
 | REDIS_HOST/PORT, POKER_PORT). SMOKE_SPAWN=0 uses an already running server.
 |
 */

process.env.GAMES = process.env.GAMES || 'poker';

const path   = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const Redis  = require('ioredis');
const { io } = require('socket.io-client');

require('../src/core/console');
const conf   = require('../src/config');
const core   = require('../src/core/models');

const TABLE_ID  = 1;
const GAME_NAME = conf.games.poker.gameName;
const PORT      = conf.games.poker.port;

const step = msg => console.log(`  ✓ ${msg}`.info);

// ---------------------------------------------------------------- redis spy
const messages = [];
const waiters  = [];

const sub = new Redis({ host : conf.redis.host, port : conf.redis.port, password : conf.redis.password });
const pub = new Redis({ host : conf.redis.host, port : conf.redis.port, password : conf.redis.password });

sub.on('message', (channel, raw) => {
	let data;
	try { data = JSON.parse(raw); } catch (e) { return; }
	if (data.gameName !== GAME_NAME) return; // other games publish on the same channel
	messages.push(data);
	for (const w of waiters.slice()) {
		if (w.match(data)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(data);
		}
	}
});

/** resolves with the first published message (from `since`) matching eventName [+ predicate] */
const published = (eventName, predicate = () => true, since = messages.length, timeout = 5000) => {
	const match = d => d.eventName === eventName && predicate(d);
	const found = messages.slice(since).find(match);
	if (found) return Promise.resolve(found);

	return new Promise((resolve, reject) => {
		const w = { match, resolve };
		waiters.push(w);
		setTimeout(() => {
			const i = waiters.indexOf(w);
			if (i >= 0) {
				waiters.splice(i, 1);
				reject(new Error(`no "${eventName}" published within ${timeout}ms`));
			}
		}, timeout);
	});
};

// ---------------------------------------------------------------- server
let server = null;

const startServer = () => new Promise((resolve, reject) => {
	if (process.env.SMOKE_SPAWN === '0') return resolve();

	server = spawn(process.execPath, ['src/index.js'], {
		cwd   : path.join(__dirname, '..'),
		env   : process.env,
		stdio : ['ignore', 'pipe', 'pipe']
	});
	let out = '';
	const onData = chunk => {
		out += chunk;
		if (process.env.SMOKE_VERBOSE) process.stdout.write(chunk);
		if (/listening on port/.test(out)) resolve();
	};
	server.stdout.on('data', onData);
	server.stderr.on('data', onData);
	server.on('exit', code => reject(new Error(`server exited (${code}):\n${out}`)));
	setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30000);
});

// ---------------------------------------------------------------- dealer socket
let socket;
const push = (payload, timeout = 8000) => socket.timeout(timeout).emitWithAck('push', payload);

async function main () {
	await core.connect();
	const m = core.forGame('poker');

	if (sub.status !== 'ready') await new Promise(resolve => sub.once('ready', resolve));
	await sub.subscribe('game-servers');

	const initSince = messages.length;
	await startServer();
	const init = await published('init', d => Array.isArray(d.tables) && typeof d.tables[0] === 'object', initSince, 15000);
	const initTable = init.tables.find(t => t.id === TABLE_ID);
	assert.ok(initTable, 'table 1 in init payload');
	assert.ok(Array.isArray(initTable.gameMarks) && initTable.gameMarks.length >= 1, 'init has game marks');
	assert.ok(initTable.betSetting && initTable.casinoBetRanges.length, 'init has settings and ranges');
	assert.ok('mainMaintenance' in init && 'mainNotice' in init);
	step(`server started, init published (${init.tables.length} tables, table 1 has ${initTable.gameMarks.length} marks)`);

	socket = io(`http://127.0.0.1:${PORT}`, { transports : ['websocket'], reconnection : false });
	await new Promise((resolve, reject) => {
		socket.on('connect', resolve);
		socket.on('connect_error', reject);
	});

	// ------------------------------------------------------------ init
	const initAck = await push({ event : 'init', data : TABLE_ID });
	assert.ok(!initAck.error, `init ack: ${JSON.stringify(initAck)}`);
	assert.equal(initAck.tableId, TABLE_ID);
	assert.ok(initAck.dealer && initAck.dealer.id, 'init ack has dealer with id');
	assert.equal(typeof initAck.betTimer, 'number');
	assert.ok('shoe' in initAck && 'autonextround' in initAck);
	step(`init: round #${initAck.roundNum} (${initAck.status}), dealer ${initAck.dealer.name}`);

	// ------------------------------------------------------------ getcardtype / gettables
	assert.equal(await push({ event : 'getcardtype', data : '0013' }), 'card');
	assert.equal(await push({ event : 'getcardtype', data : 'D0002' }), 'dealer');
	const badCard = await push({ event : 'getcardtype', data : 'XYZ' });
	assert.equal(badCard.error, true);
	step('getcardtype: card / dealer / unrecognized');

	const tables = await push({ event : 'gettables' });
	assert.equal(tables.eventName, 'init');
	assert.deepEqual(tables.tables.slice().sort(), [1, 2]);
	step(`gettables: ${JSON.stringify(tables.tables)}`);

	// ------------------------------------------------------------ newround
	let since = messages.length;
	const roundNum = await push({ event : 'newround', roundNum : initAck.roundNum });
	assert.equal(roundNum, initAck.roundNum + 1, `newround ack: ${JSON.stringify(roundNum)}`);
	const newRoundMsg = await published('newround', d => d.roundNum === roundNum, since);
	assert.equal(newRoundMsg.status, 'S');
	assert.equal(newRoundMsg.tableId, TABLE_ID);
	const round = await m.rounds.findOne({ table_id : TABLE_ID, round_num : roundNum }).lean();
	assert.ok(round && round.status === 'S', 'new round stored with status S');
	assert.equal(newRoundMsg.roundId, round._id);
	step(`newround: #${roundNum} (id ${round._id}) published`);

	// ------------------------------------------------------------ changedealer (round in S: db updated)
	since = messages.length;
	const change = await push({ event : 'changedealer', data : 'D0003' });
	assert.ok(!change.error, `changedealer ack: ${JSON.stringify(change)}`);
	assert.equal(change.eventName, 'dealerchange');
	assert.equal(change.dealerId, 3);
	await published('dealerchange', d => d.dealerId === 3, since);
	assert.equal((await m.rounds.findById(round._id).lean()).dealer_id, 3);
	assert.equal((await m.dealers.findById(3).lean()).table_name, `${GAME_NAME}# ${TABLE_ID}`);
	const badDealer = await push({ event : 'changedealer', data : 'D9999' });
	assert.equal(badDealer.error, true);
	step('changedealer: round + dealer table_name updated, dealerchange published, unknown code rejected');

	// ------------------------------------------------------------ bets (normally inserted by the bet api)
	const users = await m.users.find({ _id : { $in : [1, 3] } }).lean();
	const moneyBefore = Object.fromEntries(users.map(u => [u._id, u.money]));
	const betIds = [await m.nextId('bets'), await m.nextId('bets')];
	await m.bets.create([
		{
			_id : betIds[0], round_id : round._id, user_id : 1, type : 'r', bet_range : '20-1000', currency : 'USD',
			session_id : 'smoke-1', bet_id : `smoke-${betIds[0]}`,
			bet_history : { ante : { bet : 10 }, flop : { bet : 20 }, turn : { bet : 10 }, river : { bet : 10 }, bonus : { bet : 5 } }
		},
		{
			_id : betIds[1], round_id : round._id, user_id : 3, type : 'b', bet_range : '20-1000', currency : 'USD',
			session_id : 'smoke-3', bet_id : `smoke-${betIds[1]}`,
			bet_history : { ante : { bet : 10 }, flop : { bet : 20 }, turn : { bet : 10 }, river : { bet : 10 }, pocket : { bet : 5 }, bonusplus : { bet : 5 } }
		}
	]);
	step(`bets inserted for users 1 (transfer, type r) and 3 (seamless, type b): ${betIds.join(', ')}`);

	// ------------------------------------------------------------ timers / hold
	since = messages.length;
	await push({ event : 'bettimer', data : 15, countType : 'betting', totalTime : 20 });
	const timerMsg = await published('setbettingtime', () => true, since);
	assert.equal(timerMsg.bettingTime, 15);
	assert.equal(timerMsg.totalTime, 20);

	since = messages.length;
	await push({ event : 'stoptimer' });
	await published('stoptimer', d => d.roundNum === roundNum, since);
	step('bettimer / stoptimer published');

	since = messages.length;
	assert.equal(await push({ event : 'setroundhold', hold : true }), false);
	await published('setroundhold', d => d.status === 'H', since);
	assert.equal((await m.rounds.findById(round._id).lean()).status, 'H');
	assert.equal(await push({ event : 'setroundhold', hold : false }), true);
	await published('setroundhold', d => d.status === 'S', since);
	assert.equal((await m.rounds.findById(round._id).lean()).status, 'S');
	step('setroundhold: H then back to S');

	// ------------------------------------------------------------ progress / timerReset
	since = messages.length;
	assert.equal(await push({ event : 'setroundprogress' }), 'P');
	await published('setroundprogress', d => d.status === 'P', since);
	assert.equal(await push({ event : 'timerReset' }), 'S');
	assert.equal((await m.rounds.findById(round._id).lean()).status, 'S');
	assert.equal(await push({ event : 'setroundprogress' }), 'P');
	assert.equal(await push({ event : 'setroundprogress' }), 'Error: set round status');
	assert.equal((await m.rounds.findById(round._id).lean()).status, 'P');
	step('setroundprogress P, timerReset S, progress again P (second progress refused)');

	// ------------------------------------------------------------ cards
	// player AH AD, dealer 5C 6C, flop AC 7S 2D, turn KC, river 9H -> player trips aces
	const cards = [
		['burn', '0040'], ['player', '0013'], ['player', '0026'], ['dealer', '0004'], ['dealer', '0005'],
		['burn', '0041'], ['flop', '0000'], ['flop', '0045'], ['flop', '0027'],
		['burn', '0042'], ['turn', '0012'], ['river', '0050']
	];
	for (const [from, code] of cards) {
		since = messages.length;
		const ack = await push({ event : 'inputitem', from, data : code });
		assert.ok(!ack.error, `inputitem ${from} ${code}: ${JSON.stringify(ack)}`);
		await published('inputitem', () => true, since);
	}
	let info = (await m.rounds.findById(round._id).lean()).game_info;
	assert.deepEqual(info.player, ['0013', '0026']);
	assert.deepEqual(info.flop, ['0000', '0045', '0027']);
	assert.equal(info.river, '0050');
	step('inputitem: 12 cards stored + published');

	// removeitem river (QS) then scan the real river 9H
	since = messages.length;
	const removed = await push({ event : 'removeitem', who : 'river' });
	assert.ok(!removed.error, `removeitem: ${JSON.stringify(removed)}`);
	assert.equal(removed.river, null);
	const removedMsg = await published('removeitem', () => true, since);
	assert.equal(removedMsg.gameInfo.river, null);
	assert.equal((await m.rounds.findById(round._id).lean()).game_info.river, null);
	const riverAck = await push({ event : 'inputitem', from : 'river', data : '0021' });
	assert.equal(riverAck.river, '9H');
	assert.deepEqual(riverAck.player, ['AH', 'AD']);
	step('removeitem river, re-scanned river 9H');

	// a 4th flop card replaces the 3rd one (former JSON_SET "$.flop[2]") — then put it back
	await push({ event : 'inputitem', from : 'flop', data : '0030' });
	info = (await m.rounds.findById(round._id).lean()).game_info;
	assert.deepEqual(info.flop, ['0000', '0045', '0030']);
	await push({ event : 'inputitem', from : 'flop', data : '0027' });
	info = (await m.rounds.findById(round._id).lean()).game_info;
	assert.deepEqual(info.flop, ['0000', '0045', '0027']);
	// resync the dealer socket game info from the db
	await push({ event : 'init', data : TABLE_ID });
	step('JSON_SET $[2] semantics on a full hand');

	// ------------------------------------------------------------ results
	const partial = await push({ event : 'getpartialresults' });
	assert.ok(!partial.error, `getpartialresults: ${JSON.stringify(partial)}`);
	assert.equal(partial.winSide, 'player');
	assert.equal(partial.gameResult.handtype, 'Three of a Kind');
	assert.equal(partial.gameResult.cardsCode.length, 5);
	step(`getpartialresults: ${partial.winSide} wins with ${partial.gameResult.handtype}`);

	const display = await push({ event : 'displayresults' }, 15000);
	assert.ok(!display.error, `displayresults: ${JSON.stringify(display)}`);
	assert.equal(display.winSide, 'player');
	assert.deepEqual(display.mark, { mark : 'P' });
	assert.equal(display.gameResult.bonusAmount, 30);  // AA
	assert.equal(display.gameResult.pocketAmount, 30); // AA
	assert.equal(display.gameResult.bonusplusAmount, 0);
	step('displayresults ack: player, bonus AA 30x');

	const ended = await m.rounds.findById(round._id).lean();
	assert.equal(ended.status, 'E');
	assert.deepEqual(ended.game_result.winner, 'player');
	assert.equal(ended.game_result.handtype, 'Three of a Kind');

	const settled = await m.bets.find({ _id : { $in : betIds } }).sort({ _id : 1 }).lean();
	// user 1 (r): ante push 10, flop/turn/river 2x, bonus 5 * 30 + 5 -> 245
	assert.equal(settled[0].total_win, 245);
	assert.equal(settled[0].total_bet, 55);
	assert.equal(settled[0].total_winning, 190);
	assert.equal(settled[0].total_rolling, 45);
	assert.equal(settled[0].bet_history.bonus.win, 155);
	assert.equal(settled[0].bet_history.ante.win, 10);
	// user 3 (b): pocket AA 30x, bonusplus lost -> 245
	assert.equal(settled[1].total_win, 245);
	assert.equal(settled[1].total_lost, 5);
	assert.equal(settled[1].bet_history.pocket.win, 155);

	const after = Object.fromEntries((await m.users.find({ _id : { $in : [1, 3] } }).lean()).map(u => [u._id, u.money]));
	assert.equal(after[1], moneyBefore[1] + 245, 'transfer user credited');
	assert.equal(after[3], moneyBefore[3], 'seamless user untouched');

	const mark = await m.gameMarks.findOne({ table_id : TABLE_ID, round_id : round._id }).lean();
	assert.ok(mark, 'game mark stored');
	assert.deepEqual(mark.mark, [{ mark : 'P' }]);
	step(`settled: round E, bets 245/245, user 1 money ${moneyBefore[1]} -> ${after[1]}, user 3 unchanged, mark stored`);

	// a second displayresults must not pay again
	const again = await push({ event : 'displayresults' });
	assert.equal(again.error, true);
	assert.equal((await m.users.findById(1).lean()).money, after[1]);
	step('second displayresults refused, no double payout');

	// ------------------------------------------------------------ passResult
	since = messages.length;
	assert.equal(await push({ event : 'passResult' }), true);
	const result = await published('displayresults', d => d.roundNum === roundNum, since);
	assert.equal(result.status, 'E');
	assert.equal(result.tableId, TABLE_ID);
	assert.equal(result.roundId, round._id);
	assert.equal(result.dealerId, 3);
	assert.equal(result.totalWinning, 490);
	assert.deepEqual(result.mark, { mark : 'P' });
	assert.equal(result.userInfo.length, 2);
	const info1 = result.userInfo.find(u => u.id === 1);
	assert.equal(info1.total_winning, 245);
	assert.equal(info1.money, moneyBefore[1] + 245);
	assert.equal(result.gameResult.winner, 'player');
	assert.ok(Array.isArray(result.meta) && result.meta.length >= 2);
	assert.equal(result.meta[0].roundId, round._id);
	assert.equal(result.meta[0].gameResult.handtype, 'Three of a Kind');
	assert.equal(result.regionalResult.bets.length, 2);
	assert.ok(result.regionalResult.bets.every(b => typeof b.id === 'number'));
	step('passResult: displayresults published (totalWinning 490, userInfo, meta, mark)');

	// ------------------------------------------------------------ lastrounds / autonextround
	since = messages.length;
	assert.equal(await push({ event : 'lastrounds', remaining : 3 }), 3);
	await published('lastrounds', d => d.lastround === 3, since);
	assert.equal((await m.tables.findById(TABLE_ID).lean()).bet_setting.lastrounds, 3);
	await push({ event : 'lastrounds', remaining : 0 });
	step('lastrounds stored + published');

	const before = (await m.tables.findById(TABLE_ID).lean()).bet_setting.auto_next_round;
	const delay1 = await push({ event : 'autonextround' });
	const delay2 = await push({ event : 'autonextround' });
	assert.deepEqual(before === 'Y' ? [delay1, delay2] : [delay2, delay1], [0, 5]);
	assert.equal((await m.tables.findById(TABLE_ID).lean()).bet_setting.auto_next_round, before);
	step('autonextround toggled twice');

	// ------------------------------------------------------------ regional init shows the new mark
	since = messages.length;
	await pub.publish('regional-init', JSON.stringify({ isInit : true }));
	const reinit = await published('init', d => Array.isArray(d.tables) && typeof d.tables[0] === 'object', since);
	const t1 = reinit.tables.find(t => t.id === TABLE_ID);
	assert.equal(t1.gameMarks.length, Math.min(initTable.gameMarks.length + 1, 150));
	assert.equal(t1.roundNum, roundNum);
	assert.equal(t1.roundStatus, 'E');
	assert.deepEqual(_.last(t1.gameMarks), { mark : 'P' });
	step('regional-init: init re-published with the new mark');

	// ------------------------------------------------------------ next round
	since = messages.length;
	const next = await push({ event : 'newround', roundNum });
	assert.equal(next, roundNum + 1);
	await published('newround', d => d.roundNum === next, since);
	step(`newround: #${next}`);

	console.log('\nPOKER SMOKE TEST PASSED'.info);
}

const _ = require('lodash');

main()
	.then(() => 0, e => {
		console.log('\nPOKER SMOKE TEST FAILED'.error);
		console.log(e);
		return 1;
	})
	.then(async code => {
		if (socket) socket.close();
		if (server) {
			server.removeAllListeners('exit');
			server.kill('SIGTERM');
		}
		await Promise.allSettled([sub.quit(), pub.quit(), core.disconnect()]);
		process.exit(code);
	});
