'use strict';

/*
 |--------------------------------------------------------------------------
 | smoke-dragontiger
 |--------------------------------------------------------------------------
 | Plays one full Dragon-Tiger round against a running game server, acting
 | as the dealer page, and checks the acks, the payloads published on the
 | `game-servers` redis channel and the MongoDB state.
 |
 |   npm run seed && npm start          (same env as below)
 |   node scripts/smoke-dragontiger.js  [SMOKE_TABLE=2]
 |
 */

require('../src/core/console');
const assert = require('node:assert/strict');
const Redis  = require('ioredis');
const { io } = require('socket.io-client');
const conf   = require('../src/config');
const core   = require('../src/core/models');

const GAME     = conf.games.dragontiger.gameName;
const TABLE_ID = parseInt(process.env.SMOKE_TABLE || 2);
const models   = core.forGame('dragontiger');

const published = [];
const waiters   = [];

const sub = new Redis(conf.redis);
const pub = new Redis(conf.redis);

sub.on('message', (channel, message) => {
	let data;
	try {
		data = JSON.parse(message);
	} catch (e) {
		return;
	}
	if (data.gameName !== GAME) return;

	published.push(data);
	for (const w of [...waiters]) {
		if (w.match(data)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(data);
		}
	}
});

/** resolves with the next published message matching pred (call before triggering it) */
const waitFor = (eventName, pred = () => true, timeout = 5000) => new Promise((resolve, reject) => {
	const w = { match : d => d.eventName === eventName && pred(d), resolve };
	waiters.push(w);
	setTimeout(() => {
		if (waiters.includes(w)) {
			waiters.splice(waiters.indexOf(w), 1);
			reject(new Error(`timeout waiting for published "${eventName}"`));
		}
	}, timeout).unref();
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let socket;
const push = payload => socket.timeout(5000).emitWithAck('push', payload);

let step = 0;
const ok = (msg) => console.log(`  ✔ ${++step}. ${msg}`.info);

const round = () => models.rounds.findOne({ table_id : TABLE_ID }).sort({ _id : -1 }).lean();

async function main () {
	await core.connect();
	if (sub.status !== 'ready') await new Promise(resolve => sub.once('ready', resolve));
	await sub.subscribe('game-servers');

	socket = io(`http://127.0.0.1:${conf.games.dragontiger.port}`, { transports : ['websocket'] });
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('connect_error', reject);
	});
	ok(`connected to ${GAME} on port ${conf.games.dragontiger.port}`);

	// ---------------------------------------------------------- init / lookups
	let init = waitFor('init');
	await pub.publish('regional-init', JSON.stringify({ isInit : true }));
	init = await init;
	assert.ok(init.tables.some(t => t.id === TABLE_ID), 'init lists the table');
	assert.ok(Array.isArray(init.tables[0].gameMarks));
	ok(`regional-init re-published init (${init.tables.length} tables)`);

	assert.equal(await push({ event : 'checkifdealer', data : 'D0001' }), 'dealer');
	assert.equal(await push({ event : 'checkifdealer', data : 'AA000201' }), 'shoe');
	assert.equal(await push({ event : 'checkifdealer', data : '0012' }), 'card');
	assert.equal(await push({ event : 'checkifdealer', data : 'nope' }), false);
	ok('checkifdealer: dealer code / shoe code / card / unknown');

	const tables = await push({ event : 'gettables' });
	assert.equal(tables.eventName, 'init');
	assert.ok(tables.tables.includes(TABLE_ID));
	ok(`gettables -> [${tables.tables}]`);

	const dataRow = await push({ event : 'init', data : TABLE_ID });
	assert.ok(dataRow && dataRow.roundId, 'init ack has a round');
	assert.equal(dataRow.table, TABLE_ID);
	assert.ok(dataRow.dealer && dataRow.dealer.id);
	ok(`init table ${TABLE_ID}: round #${dataRow.roundNum} (${dataRow.status}), dealer ${dataRow.dealer.name}`);

	// ---------------------------------------------------------- shoe change
	const shoeCode = 'AA' + String(Date.now()).slice(-6);
	let shoeMsg = waitFor('shoechange');
	assert.equal(await push({ event : 'inputitem', from : 'shoe', value : shoeCode }), 'shoe changed');
	shoeMsg = await shoeMsg;
	const shoe = await models.gameMarks.findOne({ table_id : TABLE_ID }).sort({ _id : -1 }).lean();
	assert.equal(shoe.mark_num, shoeCode);
	assert.deepEqual(shoe.mark, []);
	assert.equal(shoeMsg.tableId, TABLE_ID);
	ok(`shoe change -> game_marks #${shoe._id} (${shoeCode}), shoechange published`);

	// ---------------------------------------------------------- new round
	let newRoundMsg = waitFor('newround');
	const roundNum = await push({ event : 'newround', roundNum : dataRow.roundNum });
	assert.equal(roundNum, dataRow.roundNum + 1);
	newRoundMsg = await newRoundMsg;
	let r = await round();
	assert.equal(r.round_num, roundNum);
	assert.equal(r.status, 'S');
	assert.equal(newRoundMsg.roundId, r._id);
	assert.equal(newRoundMsg.status, 'S');
	ok(`newround -> round #${roundNum} (_id ${r._id}), bettimer ${newRoundMsg.bettimer}`);

	// ---------------------------------------------------------- dealer change
	await models.dealers.updateOne({ _id : 1 }, { $set : { table_name : `${GAME}# ${TABLE_ID}` } });
	let dealerMsg = waitFor('dealerchange');
	const change = await push({ event : 'inputitem', from : 'dealer', value : 'D0003' });
	assert.equal(change.eventName, 'dealerchange');
	assert.equal(change.dealerId, 3);
	dealerMsg = await dealerMsg;
	assert.equal(dealerMsg.dealerName, 'Cara');
	r = await round();
	assert.equal(r.dealer_id, 3);
	assert.equal((await models.dealers.findById(3).lean()).table_name, `${GAME}# ${TABLE_ID}`);
	assert.equal((await models.dealers.findById(1).lean()).table_name, null);
	ok('dealer change (D0003): round.dealer_id = 3, dealers.table_name moved, dealerchange published');

	// ---------------------------------------------------------- timers / settings
	let tick = waitFor('setbettingtime', d => d.bettingTime === 10);
	socket.emit('push', { event : 'bettimer', data : 10, totalTime : 15 });
	tick = await tick;
	assert.equal(tick.totalTime, 15);
	assert.equal(tick.roundId, r._id);
	ok('bettimer -> setbettingtime published');

	await push({ event : 'setbettingtime', data : 20, totalTime : 20 });
	assert.equal((await models.tables.findById(TABLE_ID).lean()).bet_setting.betting_time, 20);
	await push({ event : 'setbettingtime', data : 15, totalTime : 15 });
	ok('setbettingtime stores bet_setting.betting_time');

	const delay = await push({ event : 'autonextround' });
	assert.equal((await models.tables.findById(TABLE_ID).lean()).bet_setting.auto_next_round, 'Y');
	assert.equal(delay, 5);
	assert.equal(await push({ event : 'autonextround' }), 0);
	ok('autonextround toggles Y (delay 5) / N (0)');

	// ---------------------------------------------------------- bets
	const [u1, u3] = await Promise.all([models.users.findById(1).lean(), models.users.findById(3).lean()]);
	const bet = async (userId, history) => models.bets.create({
		_id         : await models.nextId('bets'),
		round_id    : r._id,
		user_id     : userId,
		type        : 'r',
		bet_history : history,
		total_bet   : history.reduce((s, b) => s + b.bet_money, 0),
		bet_range   : '10-1000',
		bet_id      : `smoke-${r._id}-${userId}`,
		session_id  : 'smoke',
		currency    : 'USD'
	});
	await bet(1, [
		{ bet : 'dragon', bet_money : 100, user_money : u1.money },
		{ bet : 'dragon_big', bet_money : 50, user_money : u1.money },
		{ bet : 'tie', bet_money : 10, user_money : u1.money }
	]);
	await bet(3, [
		{ bet : 'tiger', bet_money : 100, user_money : u3.money },
		{ bet : 'tiger_hearts', bet_money : 20, user_money : u3.money }
	]);
	ok('inserted bets for user 1 (transfer) and user 3 (seamless)');

	// ---------------------------------------------------------- cards
	assert.equal(await push({ event : 'inputitem', from : 'dragon', value : '0025' }), 'roundStatusError');
	ok('dragon card refused while betting (roundStatusError)');

	const before = published.filter(d => d.eventName === 'inputitem').length;
	const burnAck = await push({ event : 'inputitem', from : 'burn', value : '0004' });
	assert.equal(burnAck.burn.id, '0004');
	await sleep(300);
	assert.equal(published.filter(d => d.eventName === 'inputitem').length - before, 1, 'burn published once');
	ok('burn card stored, ack with round data, published once');

	let progressMsg = waitFor('setroundprogress');
	assert.equal(await push({ event : 'setroundprogress' }), 'P');
	await progressMsg;
	assert.equal(await push({ event : 'setroundprogress' }), 'roundStatusError');
	assert.equal(await push({ event : 'timerReset' }), 'S');
	assert.equal(await push({ event : 'setroundprogress' }), 'P');
	assert.equal((await round()).status, 'P');
	ok('setroundprogress S->P (second call refused), timerReset P->S, progress again');

	assert.deepEqual(await push({ event : 'inputitem', from : 'dragon', value : '0025' }), { from : 'dragon', value : '0025' });
	assert.deepEqual(await push({ event : 'inputitem', from : 'tiger', value : '0035' }), { from : 'tiger', value : '0035' });

	let removeMsg = waitFor('removeitem');
	assert.equal(await push({ event : 'removeitem' }), 'tiger');
	removeMsg = await removeMsg;
	assert.equal(removeMsg.gameInfo.tiger, null);
	assert.equal((await round()).game_info.tiger, null);
	ok('dragon K♥ / tiger 10♦ dealt, removeitem removed the tiger card');

	assert.deepEqual(await push({ event : 'inputitem', from : 'tiger', value : '0016' }), { from : 'tiger', value : '0016' });
	assert.deepEqual((await round()).game_info, { burn : '0004', dragon : '0025', tiger : '0016' });
	ok('tiger 4♥ dealt');

	// ---------------------------------------------------------- hold / stop timer
	let holdMsg = waitFor('setroundhold', d => d.status === 'H');
	assert.equal(await push({ event : 'setroundhold', hold : true }), false);
	await holdMsg;
	assert.equal((await round()).status, 'H');
	holdMsg = waitFor('setroundhold', d => d.status === 'P');
	assert.equal(await push({ event : 'setroundhold', hold : false }), true);
	await holdMsg;
	assert.equal((await round()).status, 'P');
	ok('setroundhold H and back to P');

	let stopMsg = waitFor('stoptimer');
	await push({ event : 'stoptimer' });
	await stopMsg;
	ok('stoptimer published');

	// ---------------------------------------------------------- results
	const marksBefore = (await models.gameMarks.findById(shoe._id).lean()).mark.length;
	let resultMsg = waitFor('displayresults');
	const result = await push({ event : 'displayresults' });
	assert.equal(result.winner, 'dragon');
	resultMsg = await resultMsg;

	assert.equal(resultMsg.status, 'E');
	assert.equal(resultMsg.roundId, r._id);
	assert.equal(resultMsg.dealerId, 3);
	assert.deepEqual(resultMsg.gameResult, {
		winner    : 'dragon',
		side_bets : {
			dragon : { suite : 'heart', size : 'big', parity : 'odd' },
			tiger  : { suite : 'heart', size : 'small', parity : 'even' }
		}
	});
	assert.deepEqual(resultMsg.mark, { num : 13, mark : 'b' }); // "Dragon - Dragon Big Tiger Small"
	assert.equal(resultMsg.totalWinning, 380);
	assert.equal(resultMsg.userInfo.length, 2);
	assert.equal(resultMsg.regionalResult.winner, 'dragon');
	assert.equal(resultMsg.regionalResult.bets.length, 2);
	assert.ok(resultMsg.regionalResult.bets[0].id, 'bets keep an id');
	const info1 = resultMsg.userInfo.find(u => u.id === 1);
	assert.equal(info1.total_winning, 300);
	assert.equal(info1.money, u1.money + 300);
	ok('displayresults ack + published payload (winner, side bets, mark, userInfo, totalWinning 380)');

	r = await round();
	assert.equal(r.status, 'E');
	assert.equal(r.game_result.winner, 'dragon');

	const bets = await models.bets.find({ round_id : r._id }).sort({ user_id : 1 }).lean();
	assert.deepEqual(bets.map(b => [b.user_id, b.total_bet, b.total_winning, b.total_win, b.total_lost, b.total_rolling]), [
		[1, 160, 150, 300, 10, 160],
		[3, 120, 60, 80, 100, 120]
	]);
	assert.equal(bets[0].bet_history[0].win_money, 200);
	assert.equal(bets[1].bet_history[1].win_money, 80);

	const [v1, v3] = await Promise.all([models.users.findById(1).lean(), models.users.findById(3).lean()]);
	assert.equal(v1.money, u1.money + 300, 'transfer user credited');
	assert.equal(v3.money, u3.money, 'seamless user untouched');

	const marksAfter = (await models.gameMarks.findById(shoe._id).lean()).mark;
	assert.equal(marksAfter.length, marksBefore + 1);
	assert.deepEqual(marksAfter[marksAfter.length - 1], { num : 13, mark : 'b' });
	ok(`round E, bets settled, user 1 ${u1.money} -> ${v1.money}, user 3 unchanged, road map mark added`);

	const again = await push({ event : 'displayresults' });
	assert.deepEqual(again, { error : true, message : 'result already sent' });
	assert.equal((await models.users.findById(1).lean()).money, v1.money);
	assert.equal(await push({ event : 'showresults' }), true);
	ok('second displayresults refused, no double payout');

	// ---------------------------------------------------------- room disconnect (socket-server -> game server)
	const roomId = await models.nextSharedId('rooms');
	await models.rooms.create([
		{ _id : roomId, game : 'dragontiger', table_id : TABLE_ID, vendor_id : 1, name : `room-${roomId}`, type : 'R', users : [1, 2] },
		{ _id : roomId + 100000, game : 'dragontiger', table_id : TABLE_ID, vendor_id : 1, name : `dragontiger-${TABLE_ID}`, type : 'J', users : [1] }
	]);
	await pub.publish('socket-servers', JSON.stringify({
		gameType : 'dragontiger', gameName : GAME, roomId, userId : 1, tableId : TABLE_ID, vendorId : 1, type : 'J'
	}));
	let room;
	for (let i = 0; i < 20; i++) {
		await sleep(100);
		room = await models.rooms.findById(roomId).lean();
		if (room.users.length === 1) break;
	}
	assert.deepEqual(room.users, [2]);
	assert.equal(await models.rooms.exists({ vendor_id : 1, name : `dragontiger-${TABLE_ID}` }), null);
	await models.rooms.deleteOne({ _id : roomId });
	ok('room disconnect: user pulled from room, junket room removed');

	console.log(`\nsmoke-dragontiger: all ${step} checks passed`.info);
}

main()
	.then(() => 0, e => {
		console.log('smoke-dragontiger FAILED:'.error, e);
		return 1;
	})
	.then(async code => {
		if (socket) socket.close();
		await Promise.allSettled([sub.quit(), pub.quit(), core.disconnect()]);
		process.exit(code);
	});
