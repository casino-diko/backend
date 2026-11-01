'use strict';

/*
 |--------------------------------------------------------------------------
 | table control: cancel a round, last rounds, close / reopen a table
 |--------------------------------------------------------------------------
 | Dealer events every game shares, on the same 'push' channel as the game's
 | own events (GameServer attaches this next to the game controller):
 |
 |   cancelround  { supervisor : <badge code>, reason }
 |       The round (S / P / H) becomes C and every stake goes back to its
 |       player, in one transaction. The flip to C is the first write and is
 |       guarded on the open statuses, like settlement's flip to E, so a round
 |       is never both paid and refunded, nor refunded twice. Transfer wallets
 |       get users.money back with a `refund` row in transactions; seamless
 |       refunds are queued in vendor_calls for the vendor's API.
 |       Publishes `roundcancelled`.
 |
 |   lastrounds   { remaining : n }
 |       n > 0: the table closes after n more results (the current round counts
 |       while it has none). 0 clears it. Stored in bet_setting.lastrounds and
 |       published as `lastrounds` { lastround : n }, the event the poker
 |       client's "LAST ROUNDS" panel already shows. Each result counts one
 |       down (afterResult); at 0 the table closes: bet_setting.closed, the
 |       "Now" maintenance and `tableclosed`. newround is refused meanwhile.
 |
 |   reopentable  {}
 |       Clears closed, the countdown and the maintenance.
 |
 | The games call beforeNewRound() / afterResult() around their own events.
 |
 */

const OPEN = ['S', 'P', 'H'];

const CANCEL_REASONS = ['misdeal', 'card dropped', 'scanner fault', 'video lost', 'other'];

// path segment of the vendor API (/api/transact/<game>/<type>), as the web front uses it
const API_GAME = { baccarat : 'baccarat', dragontiger : 'dragon-tiger', poker : 'poker' };

const CLOSED_TEXT = {
	main : 'This table is closed.',
	sub  : 'Please choose another table.'
};

const round2 = n => Math.round(n * 100) / 100;

class TableControlError extends Error {}

/**
 * Pure: what to give back for each bet of a cancelled round. Bets without a
 * stake or already refunded / rolled back get nothing.
 * @returns {{ betId, userId, vendorId, amount, wallet, bet, user, vendor }[]}
 */
function planRefunds (bets, usersById, vendorsById) {
	const plan = [];
	for (const bet of bets) {
		if (bet.status === 'refunded' || bet.status === 'rolled_back') continue;
		const amount = round2(Number(bet.total_bet) || 0);
		if (amount <= 0) continue;

		const user = usersById[bet.user_id];
		if (!user) throw new TableControlError(`player ${bet.user_id} of bet ${bet._id} not found`);
		const vendor = vendorsById[user.vendor_id];
		if (!vendor) throw new TableControlError(`vendor ${user.vendor_id} of player ${user._id} not found`);

		plan.push({
			betId    : bet._id,
			userId   : user._id,
			vendorId : vendor._id,
			amount,
			wallet   : vendor.integration_type === 'seamless' ? 'seamless' : 'transfer',
			bet, user, vendor
		});
	}
	return plan;
}

/**
 * Pure: the countdown after one more result.
 * @returns {{ counting : boolean, left : number, closes : boolean }}
 */
function countDown (lastrounds) {
	const left = Number(lastrounds) || 0;
	if (left <= 0) return { counting : false, left : 0, closes : false };
	return { counting : true, left : left - 1, closes : left - 1 === 0 };
}

/** refunds per player, for the players' balance (seamless balances live at the vendor: money null) */
function refundsByUser (plan, balances) {
	const byUser = {};
	for (const p of plan) {
		const row = byUser[p.userId] || (byUser[p.userId] = { id : p.userId, amount : 0, money : null });
		row.amount = round2(row.amount + p.amount);
		if (p.wallet === 'transfer') row.money = balances[p.userId];
	}
	return Object.values(byUser);
}

/** the dealer record of a supervisor badge, or null */
async function findSupervisor (models, code) {
	code = String(code || '').trim();
	if (!code) return null;
	return models.dealers.findOne({ code, supervisor : true, status : '1' }, { _id : 1, real_name : 1, name : 1, code : 1 }).lean();
}

/**
 * Cancels an open round and refunds every stake. Throws TableControlError
 * when the round is not open (anymore).
 */
async function cancelRound (models, { key, tableId, roundNum, reason, dealerId, supervisorId }) {
	tableId  = parseInt(tableId);
	roundNum = parseInt(roundNum);

	return models.withTransaction(async session => {
		const round = await models.rounds.findOneAndUpdate(
			{ table_id : tableId, round_num : roundNum, status : { $in : OPEN } },
			{ $set : { status : 'C', closed : {
				action        : 'cancel',
				reason,
				dealer_id     : dealerId ? parseInt(dealerId) : null,
				supervisor_id : supervisorId,
				at            : new Date()
			} } },
			{ session, new : true }
		).lean();

		if (!round) {
			throw new TableControlError(`round ${roundNum} of table ${tableId} is not open: it already has a result or was cancelled`);
		}

		const bets = await models.bets.find({ round_id : round._id }).session(session).lean();
		const userIds = [...new Set(bets.map(b => b.user_id))];
		const users = await models.users.find({ _id : { $in : userIds } }, { vendor_id : 1, user_id : 1, user_name : 1, money : 1, currency : 1 }).session(session).lean();
		const vendors = await models.vendors.find({ _id : { $in : [...new Set(users.map(u => u.vendor_id))] } }, { integration_type : 1, vendor_name : 1, currency : 1 }).session(session).lean();

		const plan = planRefunds(bets, keyBy(users), keyBy(vendors));
		const amountByBet = Object.fromEntries(plan.map(p => [p.betId, p.amount]));

		// total_win is what went back to the player (settlement's meaning: credited, stake included),
		// so every bet history shows a refunded bet as even, never as a loss
		if (bets.length) {
			await models.bets.bulkWrite(bets.map(b => ({
				updateOne : {
					filter : { _id : b._id, status : { $nin : ['refunded', 'rolled_back'] } },
					update : { $set : { status : 'refunded', refunded : amountByBet[b._id] || 0, total_win : amountByBet[b._id] || 0, total_winning : 0, total_lost : 0 } }
				}
			})), { session });
		}

		const balances = {};
		for (const p of plan) {
			if (p.wallet === 'transfer') {
				const after = await models.users.findOneAndUpdate({ _id : p.userId }, { $inc : { money : p.amount } }, { session, new : true, projection : { money : 1 } }).lean();
				const balance = round2(Number(after.money) || 0);
				if (balance !== after.money) await models.users.updateOne({ _id : p.userId }, { $set : { money : balance } }, { session });
				balances[p.userId] = balance;

				await models.transactions.create([{
					_id            : await models.nextSharedId('transactions', session),
					user_id        : p.userId,
					vendor_id      : p.vendorId,
					type           : 'refund',
					amount         : p.amount,
					balance_before : round2(balance - p.amount),
					balance_after  : balance,
					currency       : p.user.currency || p.vendor.currency || null,
					note           : `Round ${roundNum} cancelled: ${reason}`,
					admin          : null,
					request_id     : `refund:${key}:${p.betId}`,
					game           : key,
					table_id       : tableId,
					round_id       : round._id,
					round_num      : roundNum,
					bet_id         : p.betId
				}], { session });
			} else {
				await models.vendorCalls.create([{
					_id       : `${key}:${p.betId}:refund`,
					vendor_id : p.vendorId,
					user_id   : p.userId,
					game      : API_GAME[key],
					type      : 'refund',
					body      : {
						type        : 'refund',
						action_id   : `${key}:${p.betId}:refund`,
						bet_id      : p.bet.bet_id || null,
						amount      : p.amount,
						user_id     : p.user.user_id,
						user_name   : p.user.user_name,
						range       : p.bet.bet_range || null,
						table       : tableId,
						round_no    : roundNum,
						currency    : p.user.currency || p.vendor.currency || null,
						vendor_id   : p.vendorId,
						vendor_name : p.vendor.vendor_name,
						reason
					}
				}], { session });
			}
		}

		return { round, plan, refunds : refundsByUser(plan, balances) };
	});
}

const keyBy = rows => Object.fromEntries(rows.map(r => [r._id, r]));

// ------------------------------------------------------------------ closing a table

/**
 * Turns the table's "Now" maintenance on or off. The setting has two shapes:
 * baccarat / poker { maintenance : [{ type, info : [Periodic, Now] }] },
 * dragon-tiger [Periodic, Now].
 */
async function setNowMaintenance (models, tableId, on) {
	const table = await models.tables.findById(tableId, { maintenance_setting : 1 }).lean();
	if (!table) throw new TableControlError(`table ${tableId} not found`);

	const now = {
		division   : 'Now',
		status     : on ? 1 : 0,
		main_text  : on ? CLOSED_TEXT.main : '',
		sub_text   : on ? CLOSED_TEXT.sub : '',
		start_time : on ? new Date() : null,
		end_time   : null
	};

	const setting = table.maintenance_setting || {};
	if (Array.isArray(setting)) {
		setting[1] = Object.assign({}, setting[1], now);
	} else if (Array.isArray(setting.maintenance)) {
		for (const m of setting.maintenance) {
			m.info = Array.isArray(m.info) ? m.info : [];
			m.info[1] = Object.assign({}, m.info[1], now);
		}
	}
	await models.tables.updateOne({ _id : tableId }, { $set : { maintenance_setting : setting } });

	// the socket-server stores it for the table's players (Namespace 'maintenancechange')
	return { division : 'Now', slave : 'all', status : now.status, main_text : now.main_text, sub_text : now.sub_text, start_date : now.start_time, end_date : null };
}

/** throws when the table is closed (after its last rounds) */
async function beforeNewRound (models, tableId) {
	const table = await models.tables.findById(parseInt(tableId), { bet_setting : 1 }).lean();
	if (table && table.bet_setting && table.bet_setting.closed) {
		throw new TableControlError('table closed after its last rounds: reopen it first');
	}
	const left = table && table.bet_setting ? Number(table.bet_setting.lastrounds) || 0 : 0;
	return { lastrounds : left };
}

/**
 * Counts the last rounds down after a result. Resolves the events to
 * publish (an empty list when no countdown is running).
 */
async function afterResult (models, { gameName, tableId, roundId, roundNum, dealerId }) {
	tableId = parseInt(tableId);
	const table = await models.tables.findById(tableId, { bet_setting : 1 }).lean();
	const step = countDown(table && table.bet_setting && table.bet_setting.lastrounds);
	if (!step.counting) return [];

	// guarded on the value read, so two results never count the same round twice
	const set = { 'bet_setting.lastrounds' : step.left };
	if (step.closes) set['bet_setting.closed'] = true;
	const r = await models.tables.updateOne({ _id : tableId, 'bet_setting.lastrounds' : table.bet_setting.lastrounds }, { $set : set });
	if (!r.modifiedCount) return [];

	const base = { gameName, tableId, roundId : parseInt(roundId), roundNum : parseInt(roundNum), dealerId : parseInt(dealerId) };
	const events = [Object.assign({ eventName : 'lastrounds', lastround : step.left }, base)];
	if (step.closes) {
		const data = await setNowMaintenance(models, tableId, true);
		events.push(Object.assign({ eventName : 'maintenanceChange', data }, base));
		events.push(Object.assign({ eventName : 'tableclosed', text : CLOSED_TEXT }, base));
	}
	return events;
}

// ------------------------------------------------------------------ dealer events

/**
 * Listens for the shared dealer events on a dealer socket.
 * @param {object} socket   dealer socket (tableId, roundId, roundNum, dealerId, gameName set by the game)
 * @param {object} opts     { models, key, publish }
 */
function attach (socket, { models, key, publish }) {
	socket.on('push', (data, next) => {
		next = (typeof next === 'function') ? next : (() => {});
		if (!data || typeof data !== 'object') return;

		const handler = handlers[data.event];
		if (!handler) return;

		const base = () => ({
			gameName : socket.gameName,
			tableId  : parseInt(socket.tableId),
			roundId  : parseInt(socket.roundId),
			roundNum : parseInt(socket.roundNum),
			dealerId : parseInt(socket.dealerId)
		});

		if (!socket.tableId) {
			next({ error : true, message : 'table not initialised: refresh the page' });
			return;
		}

		Promise.resolve()
			.then(() => handler({ socket, models, key, publish, base, data : data.data || data }))
			.then(next)
			.catch(e => {
				const message = e instanceof TableControlError ? e.message : 'server error';
				if (!(e instanceof TableControlError)) console.log(`[${socket.gameName}] ${data.event} failed`.error, e);
				next({ error : true, message });
			});
	});
}

const handlers = {
	async cancelround ({ socket, models, key, publish, base, data }) {
		const reason = String(data.reason || '').trim().toLowerCase();
		if (!CANCEL_REASONS.includes(reason)) {
			throw new TableControlError(`choose a reason: ${CANCEL_REASONS.join(', ')}`);
		}

		const supervisor = await findSupervisor(models, data.supervisor);
		if (!supervisor) throw new TableControlError('scan a supervisor badge to cancel the round');

		const { round, refunds } = await cancelRound(models, {
			key,
			tableId      : socket.tableId,
			roundNum     : socket.roundNum,
			reason,
			dealerId     : socket.dealerId,
			supervisorId : supervisor._id
		});

		socket.status = socket.postStatus = 'C';

		const event = Object.assign(base(), {
			eventName  : 'roundcancelled',
			roundId    : round._id,
			roundNum   : round.round_num,
			status     : 'C',
			reason,
			supervisor : supervisor.real_name || supervisor.name || supervisor.code,
			refunds,
			totalRefunded : round2(refunds.reduce((s, r) => s + r.amount, 0))
		});
		publish(event);
		return { status : 'C', roundNum : round.round_num, refunds, totalRefunded : event.totalRefunded };
	},

	async lastrounds ({ socket, models, publish, base, data }) {
		const n = Number(data.remaining);
		if (!Number.isInteger(n) || n < 0 || n > 99) throw new TableControlError('rounds left must be 0 to 99');

		await models.tables.updateOne({ _id : parseInt(socket.tableId) }, { $set : { 'bet_setting.lastrounds' : n } });
		publish(Object.assign(base(), { eventName : 'lastrounds', lastround : n }));
		return n;
	},

	async reopentable ({ socket, models, publish, base }) {
		const tableId = parseInt(socket.tableId);
		await models.tables.updateOne({ _id : tableId }, { $set : { 'bet_setting.lastrounds' : 0, 'bet_setting.closed' : false } });
		const data = await setNowMaintenance(models, tableId, false);
		publish(Object.assign(base(), { eventName : 'maintenanceChange', data }));
		publish(Object.assign(base(), { eventName : 'lastrounds', lastround : 0 }));
		publish(Object.assign(base(), { eventName : 'tablereopened' }));
		return true;
	}
};

module.exports = {
	attach, cancelRound, beforeNewRound, afterResult, findSupervisor,
	planRefunds, countDown, refundsByUser,
	CANCEL_REASONS, TableControlError
};
