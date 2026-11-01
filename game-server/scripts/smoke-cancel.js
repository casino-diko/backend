'use strict';

/*
 |--------------------------------------------------------------------------
 | smoke-cancel
 |--------------------------------------------------------------------------
 | Round cancel, last rounds and table close / reopen (core/tableControl)
 | against a running game server, acting as a Dragon-Tiger dealer page:
 |
 |   - cancelround is refused without a supervisor badge or a known reason
 |   - with S0001: round C, every stake back (transfer: users.money and a
 |     `refund` transaction; seamless: a queued vendor_calls refund),
 |     roundcancelled published; a second cancel, progress or result refused
 |   - lastrounds 1 -> one more result closes the table (maintenance "Now",
 |     tableclosed), newround refused until reopentable
 |
 | Stop the dealer simulator first: it plays the same table.
 |
 |   npm run seed && npm start
 |   node scripts/smoke-cancel.js       [SMOKE_TABLE=2] [GAME_HOST=127.0.0.1]
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
const HOST     = process.env.GAME_HOST || '127.0.0.1';
const models   = core.forGame('dragontiger');

const waiters = [];
const sub = new Redis(conf.redis);

sub.on('message', (channel, message) => {
	let data;
	try {
		data = JSON.parse(message);
	} catch (e) {
		return;
	}
	if (data.gameName !== GAME || data.tableId !== TABLE_ID) return;
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

let socket;
const push = payload => socket.timeout(8000).emitWithAck('push', payload);

let step = 0;
const ok = msg => console.log(`  ✔ ${++step}. ${msg}`.info);

const round = () => models.rounds.findOne({ table_id : TABLE_ID }).sort({ _id : -1 }).lean();
const table = () => models.tables.findById(TABLE_ID).lean();

/** dealt Dragon-Tiger round up to its result */
async function playToResult () {
	await push({ event : 'inputitem', from : 'burn', value : '0004' });
	assert.equal(await push({ event : 'setroundprogress' }), 'P');
	await push({ event : 'inputitem', from : 'dragon', value : '0025' });
	await push({ event : 'inputitem', from : 'tiger', value : '0016' });
	const result = await push({ event : 'displayresults' });
	assert.equal(result.winner, 'dragon');
}

async function main () {
	await core.connect();
	if (sub.status !== 'ready') await new Promise(resolve => sub.once('ready', resolve));
	await sub.subscribe('game-servers');

	socket = io(`http://${HOST}:${conf.games.dragontiger.port}`, { transports : ['websocket'] });
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('connect_error', reject);
	});

	// a table left closed by an interrupted run
	await models.tables.updateOne({ _id : TABLE_ID }, { $set : { 'bet_setting.lastrounds' : 0, 'bet_setting.closed' : false } });

	const dataRow = await push({ event : 'init', data : TABLE_ID });
	assert.ok(dataRow && dataRow.roundId, 'init ack has a round');
	// finish whatever round the table was in
	if (['S', 'P', 'H'].includes(dataRow.status)) {
		await push({ event : 'cancelround', data : { supervisor : 'S0001', reason : 'other' } });
	}
	let roundNum = await push({ event : 'newround', roundNum : (await round()).round_num });
	let r = await round();
	assert.equal(r.status, 'S');
	ok(`${GAME} table ${TABLE_ID}: round #${roundNum} betting`);

	// ---------------------------------------------------------- bets, debited like the web bet store does
	const before = Object.fromEntries((await models.users.find({ _id : { $in : [1, 3] } }, { money : 1 }).lean()).map(u => [u._id, u.money]));
	const bet = async (userId, stake) => {
		const id = await models.nextId('bets');
		await models.bets.create({
			_id : id, round_id : r._id, user_id : userId, type : 'r',
			bet_history : [{ bet : 'dragon', bet_money : stake, win_money : 0, user_money : before[userId] - stake }],
			total_bet : stake, total_rolling : stake, bet_range : '10-1000', bet_id : `smoke-cancel-${r._id}-${userId}`, currency : 'USD'
		});
		return id;
	};
	const bet1 = await bet(1, 150);
	await models.users.updateOne({ _id : 1 }, { $inc : { money : -150 } });
	const bet3 = await bet(3, 120); // seamless: the vendor holds the balance
	ok('player 1 (transfer) bet 150, player 3 (seamless) bet 120');

	// ---------------------------------------------------------- refusals
	let e = await push({ event : 'cancelround', data : { reason : 'misdeal' } });
	assert.equal(e.error, true);
	assert.match(e.message, /supervisor/);
	e = await push({ event : 'cancelround', data : { supervisor : 'D0001', reason : 'misdeal' } });
	assert.match(e.message, /supervisor/, 'a dealer badge is not a supervisor badge');
	e = await push({ event : 'cancelround', data : { supervisor : 'S0001', reason : 'bored' } });
	assert.match(e.message, /reason/);
	assert.equal((await round()).status, 'S');
	ok('cancel refused: no badge, a dealer badge, an unknown reason (round still S)');

	// ---------------------------------------------------------- cancel
	let cancelled = waitFor('roundcancelled');
	const ack = await push({ event : 'cancelround', data : { supervisor : 'S0001', reason : 'Misdeal' } });
	assert.equal(ack.status, 'C', JSON.stringify(ack));
	assert.equal(ack.totalRefunded, 270);
	cancelled = await cancelled;
	assert.equal(cancelled.roundId, r._id);
	assert.equal(cancelled.reason, 'misdeal');
	assert.deepEqual(cancelled.refunds.sort((a, b) => a.id - b.id), [
		{ id : 1, amount : 150, money : before[1] },
		{ id : 3, amount : 120, money : null }
	]);
	ok('cancelround with S0001: ack C, 270 refunded, roundcancelled published with each player\'s refund');

	r = await round();
	assert.equal(r.status, 'C');
	assert.equal(r.closed.action, 'cancel');
	assert.equal(r.closed.supervisor_id, 4);
	const bets = await models.bets.find({ _id : { $in : [bet1, bet3] } }).sort({ _id : 1 }).lean();
	assert.deepEqual(bets.map(b => [b.status, b.refunded, b.total_win]), [['refunded', 150, 150], ['refunded', 120, 120]]);
	assert.equal((await models.users.findById(1).lean()).money, before[1]);
	assert.equal((await models.users.findById(3).lean()).money, before[3]);
	const tx = await models.transactions.findOne({ request_id : `refund:dragontiger:${bet1}` }).lean();
	assert.equal(tx.type, 'refund');
	assert.equal(tx.amount, 150);
	assert.equal(tx.balance_after, before[1]);
	assert.equal(tx.balance_before, before[1] - 150);
	assert.equal(tx.round_id, r._id);
	const call = await models.vendorCalls.findById(`dragontiger:${bet3}:refund`).lean();
	assert.equal(call.game, 'dragon-tiger');
	assert.equal(call.body.amount, 120);
	assert.equal(call.body.bet_id, `smoke-cancel-${r._id}-3`);
	assert.equal(call.done_at, undefined);
	ok('round C (supervisor 4), bets refunded, player 1 back to its balance with a refund transaction, player 3 refund queued for the vendor');

	e = await push({ event : 'cancelround', data : { supervisor : 'S0001', reason : 'misdeal' } });
	assert.match(e.message, /not open/);
	assert.equal(await push({ event : 'setroundprogress' }), 'roundStatusError');
	const res = await push({ event : 'displayresults' });
	assert.ok(res === false || res.error, 'no result for a cancelled round');
	assert.equal((await round()).status, 'C');
	assert.equal(await models.transactions.countDocuments({ round_id : r._id }), 1, 'refunded once');
	ok('a second cancel, progress and results are refused; refunded once');

	// ---------------------------------------------------------- last rounds
	roundNum = await push({ event : 'newround', roundNum : r.round_num });
	assert.equal(roundNum, r.round_num + 1);
	ok(`newround after the cancel -> #${roundNum}`);

	let left = waitFor('lastrounds', d => d.lastround === 1);
	assert.equal(await push({ event : 'lastrounds', data : { remaining : 1 } }), 1);
	await left;
	assert.equal((await table()).bet_setting.lastrounds, 1);
	ok('lastrounds 1 stored and published');

	left = waitFor('lastrounds', d => d.lastround === 0);
	const maint = waitFor('maintenanceChange', d => d.data.status === 1);
	const closed = waitFor('tableclosed');
	await playToResult();
	await left;
	assert.equal((await maint).data.division, 'Now');
	await closed;
	let t = await table();
	assert.equal(t.bet_setting.lastrounds, 0);
	assert.equal(t.bet_setting.closed, true);
	assert.equal(t.maintenance_setting[1].status, 1);
	ok('the last result closed the table: lastrounds 0, maintenance Now on, tableclosed published');

	e = await push({ event : 'newround', roundNum : (await round()).round_num });
	assert.equal(e.error, true);
	assert.match(e.message, /closed/);
	ok('newround refused while closed');

	const reopened = waitFor('maintenanceChange', d => d.data.status === 0);
	assert.equal(await push({ event : 'reopentable' }), true);
	await reopened;
	t = await table();
	assert.equal(t.bet_setting.closed, false);
	assert.equal(t.maintenance_setting[1].status, 0);
	roundNum = await push({ event : 'newround', roundNum : (await round()).round_num });
	assert.equal((await round()).status, 'S');
	ok(`reopentable: maintenance off, newround -> #${roundNum}`);

	console.log('\nsmoke-cancel passed'.info);
}

main().then(() => {
	socket.close();
	sub.quit();
	return core.disconnect();
}).catch(err => {
	console.log('\nsmoke-cancel FAILED'.error);
	console.log(err);
	process.exitCode = 1;
	if (socket) socket.close();
	sub.quit();
	core.disconnect();
});
