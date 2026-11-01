'use strict';

	/*
	|--------------------------------------------------------------------------
	| services v2.0
	|--------------------------------------------------------------------------
	| Author : Shinji Escorido
	| Service module/component for processing model datas (MongoDB)
	|
	*/

const deck   = require('./cardsModule');
const _      = require('lodash');
const moment = require('moment');
const models = require('./db');

// cards a dealer can swipe and the round statuses each one is accepted in
const CARD_SLOTS = {
	burn   : ['S', 'P'],
	dragon : ['P'],
	tiger  : ['P']
};

const formatMinute = date => (date ? moment.utc(date).format('YYYY-MM-DD HH:mm:00') : null);

const cardInfo = id => {
	const card = new deck(id);

	return {
		id,
		value  : card.value,
		suite  : card.suite,
		parity : card.parity,
		size   : card.size
	};
};

// sequelize returned `id`, keep that for every row sent out
const plainBet = bet => ({
	id            : bet._id,
	round_id      : bet.round_id,
	type          : bet.type,
	user_id       : bet.user_id,
	bet_history   : bet.bet_history,
	total_bet     : bet.total_bet,
	total_winning : bet.total_winning,
	created_at    : bet.created_at,
	updated_at    : bet.updated_at,
	bet_id        : bet.bet_id,
	session_id    : bet.session_id,
	bet_range     : bet.bet_range,
	currency      : bet.currency,
	user          : bet.user ? {
		id           : bet.user._id,
		vendor_id    : bet.user.vendor_id,
		user_id      : bet.user.user_id,
		user_name    : bet.user.user_name,
		money        : bet.user.money,
		user_type    : bet.user.user_type,
		currency     : bet.user.currency,
		denomination : bet.user.denomination,
		vendor       : bet.user.vendor ? {
			id               : bet.user.vendor._id,
			type             : bet.user.vendor.type,
			integration_type : bet.user.vendor.integration_type,
			currency         : bet.user.vendor.currency,
			multiplier       : bet.user.vendor.multiplier
		} : null
	} : null
});

const resultError = message => ({ error : true, message });

module.exports = {
	async fnProcessBetTimer (time, tableId) {
		const r = await models.tables.updateOne(
			{ _id : tableId },
			{ $set : { 'bet_setting.betting_time' : time.data } }
		);

		if (!r.matchedCount) {
			throw new Error('Error: table not found');
		}

		return time;
	},

	/**
	 * info_marks.mark_info looks like "Dragon - Dragon Big Tiger Small";
	 * returns { 'dragon.10' : mark, ... } (1 = big, 0 = small)
	 */
	async fnFetchMarks () {
		const marks = await models.infoMarks.find({}).lean();
		return this.fnParseMarks(marks);
	},

	fnParseMarks (marks) {
		const markData = {};

		_.forEach(marks, value => {
			const splitInfo = String(value.mark_info || '').trim().split(' - ');

			if (splitInfo.length > 1) {
				const markTransform = splitInfo[1].toLowerCase()
					.replace(/ /g, '')
					.replace(/dragon/g, '')
					.replace(/tiger/g, '')
					.replace(/big/g, '1')
					.replace(/small/g, '0');

				markData[splitInfo[0].toLowerCase() + '.' + markTransform] = value.mark;
			}
		});

		return markData;
	},

	/** toggles bet_setting.auto_next_round, resolves the delay (0 when turned off) */
	async fnProcessAutoNextRound (tableId) {
		const table = await models.tables.findById(tableId, { bet_setting : 1 }).lean();

		if (!table) {
			throw new Error('Error: table not found');
		}

		const settings = table.bet_setting || {};
		const autoNextRound = (settings.auto_next_round == 'Y') ? 'N' : 'Y';

		await models.tables.updateOne({ _id : tableId }, { $set : { 'bet_setting.auto_next_round' : autoNextRound } });

		return (autoNextRound == 'Y') ? settings.delay_time : 0;
	},

	async fnProcessDeleteCard (data, arrayDeleted, tableId, roundNum) {
		if (!arrayDeleted) {
			arrayDeleted = 'burn';
		}

		try {
			await models.rounds.updateMany(
				{ table_id : tableId, round_num : roundNum },
				{ $set : { [`game_info.${arrayDeleted}`] : null } }
			);
		} catch (e) {
			throw 'Error: delete card';
		}

		return { arrayDeleted };
	},

	async fnProcessNewRound (tableId, dealerId, dealerName, shoeId, roundNum) {
		const round = await models.rounds.create({
			_id       : await models.nextId('rounds'),
			dealer_id : dealerId,
			game_info : { dragon : null, tiger : null, burn : null },
			round_num : parseInt(roundNum) + 1,
			table_id  : tableId,
			status    : 'S'
		});

		return {
			id        : round._id,
			round_num : round.round_num
		};
	},

	/**
	 * Winner and side bet results from the round's cards (pure).
	 * Throws { error, message } when the round cannot be resulted.
	 */
	fnBuildResult (round) {
		if (round.status == 'E') {
			throw resultError('result already sent');
		}

		if (round.status == 'S') {
			throw resultError('status not in progress');
		}

		const card = round.game_info || {};

		if (!card.dragon || !card.tiger) {
			throw resultError('not enough cards');
		}

		const dragon = cardInfo(card.dragon);
		const tiger  = cardInfo(card.tiger);

		if (!dragon.value || !tiger.value) {
			throw resultError('missing values');
		}

		const result = {
			gameInfo   : card,
			created_at : round.created_at,
			updated_at : round.updated_at,
			tableId    : round.table_id,
			roundId    : round._id,
			roundNum   : round.round_num,
			winner     : null,
			cards      : { dragon, tiger },
			bets       : round.bets || []
		};

		if (dragon.value > tiger.value) {
			result.winner = 'dragon';
		}
		else if (tiger.value > dragon.value) {
			result.winner = 'tiger';
		}
		else {
			result.winner = ((dragon.suite == tiger.suite) && dragon.value != 7) ? 'suited tie' : 'tie';
		}

		const sideBet = c => (c.value == 7) ? 'seven' : { suite : c.suite, size : c.size, parity : c.parity };

		return {
			gameResult : {
				game_result : {
					winner    : result.winner,
					side_bets : {
						dragon : sideBet(dragon),
						tiger  : sideBet(tiger)
					}
				},
				status : 'E'
			},
			result,
			gameInfo    : card,
			// status the settlement expects the round to still be in
			roundStatus : round.status
		};
	},

	async fnGetResults (roundId, tableId, roundNum) {
		let round;

		try {
			round = await models.rounds.findOne({ table_id : tableId, round_num : roundNum })
				.sort({ _id : -1 })
				.populate({
					path     : 'bets',
					options  : { sort : { _id : 1 } },
					populate : { path : 'user', populate : { path : 'vendor' } }
				})
				.lean();
		} catch (e) {
			throw resultError(e.message);
		}

		if (!round) {
			throw resultError('round empty');
		}

		round.bets = _.map(round.bets, plainBet);

		return this.fnBuildResult(round);
	},

	/** sets the round status; with expectedStatus only when the round is still in it */
	async fnSetRoundStatus (roundId, status, tableId, roundNum, expectedStatus = null) {
		// a resulted, cancelled or voided round is never reopened
		const filter = { table_id : tableId, round_num : roundNum, status : { $in : ['S', 'P', 'H'] } };

		if (expectedStatus) {
			filter.status = expectedStatus;
		}

		const r = await models.rounds.updateMany(filter, { $set : { status } });
		return r.matchedCount > 0;
	},

	async fnGetCurrentRoundDatas (tableId) {
		const data = await models.rounds.findOne({ table_id : tableId })
			.sort({ _id : -1 })
			.populate('dealer', 'real_name name dealer_image')
			.populate('table', 'bet_setting')
			.lean();

		if (!data || !data.table) {
			throw new Error('Error: init');
		}

		const gameInfo    = data.game_info || {};
		const betSettings = data.table.bet_setting || {};
		let postStatus    = data.status;

		// get post status logic
		if (data.status == 'H') {
			if (data.game_result) {
				postStatus = 'E';
			}
			else if (!gameInfo.burn && !gameInfo.dragon && !gameInfo.tiger) {
				postStatus = 'S';
			}
			else {
				postStatus = 'P';
			}
		}

		const mark = await models.gameMarks.findOne({ table_id : tableId }, { _id : 1 }).sort({ _id : -1 }).lean();

		return {
			roundId       : data._id,
			roundNum      : data.round_num,
			dealer        : data.dealer ? {
				id           : data.dealer._id,
				real_name    : data.dealer.real_name,
				name         : data.dealer.name,
				dealer_image : data.dealer.dealer_image
			} : null,
			autonextround : (betSettings.auto_next_round == 'Y') ? betSettings.delay_time : 0,
			bettimer      : betSettings.betting_time || 0,
			dragon        : (gameInfo.dragon) ? new deck(gameInfo.dragon) : null,
			tiger         : (gameInfo.tiger) ? new deck(gameInfo.tiger) : null,
			burn          : (gameInfo.burn) ? new deck(gameInfo.burn) : null,
			table         : data.table._id,
			status        : data.status,
			gameInfo      : _.clone(gameInfo),
			postStatus,
			shoeId        : mark ? mark._id : null,
			done          : !!data.game_result
		};
	},

	/**
	 * Handles a scanned item: a dealer card (dealer change), a shoe card
	 * (new road map) or a game card (burn / dragon / tiger).
	 * Resolves the data to publish, a new shoe id, 'roundStatusError' or false.
	 */
	async fnProcessCard (value, type, roundNum, roundId, realName, tableId, gameName, status) {
		if (type == 'dealer') {
			return this.fnChangeDealer(value, roundNum, roundId, tableId, gameName, status);
		}

		if (type == 'shoe') {
			try {
				const mark = await models.gameMarks.create({
					_id      : await models.nextId('game_marks'),
					table_id : tableId,
					mark     : [],
					mark_num : value
				});
				return mark._id;
			} catch (e) {
				return false;
			}
		}

		if (!value || !CARD_SLOTS[type]) {
			return false;
		}

		try {
			const r = await models.rounds.updateMany(
				{ status : { $in : CARD_SLOTS[type] }, table_id : tableId, round_num : roundNum },
				{ $set : { [`game_info.${type}`] : value } }
			);

			if (!r.matchedCount) {
				return 'roundStatusError';
			}
		} catch (e) {
			return false;
		}

		return {
			value,
			type,
			gameName,
			roundId,
			eventName : 'inputitem',
			tableId,
			roundNum
		};
	},

	async fnChangeDealer (code, roundNum, roundId, tableId, gameName, status) {
		try {
			const dealer = await models.dealers.findOne({ code }, { name : 1, dealer_image : 1, table_image : 1 }).lean();

			if (!dealer) {
				// means dealer not found
				return false;
			}

			const dealerChangeData = {
				gameName,
				roundId,
				roundNum,
				eventName   : 'dealerchange',
				tableId,
				dealerId    : dealer._id,
				dealerName  : dealer.name,
				dealerImage : dealer.dealer_image,
				tableImage  : dealer.table_image
			};

			// mid round the change is only kept in memory (applied on the next round)
			if (status != 'S') {
				return dealerChangeData;
			}

			const tableName = `${gameName}# ${tableId}`;

			await models.withTransaction(async session => {
				// the previous dealer leaves the table ...
				await models.dealers.updateMany({ table_name : tableName }, { $set : { table_name : null } }, { session });

				// ... the new one takes the current round (the former UPDATE ... JOIN only touched the dealer when the round exists)
				const r = await models.rounds.updateMany(
					{ table_id : tableId, round_num : roundNum },
					{ $set : { dealer_id : dealer._id } },
					{ session }
				);

				if (r.matchedCount) {
					await models.dealers.updateOne({ _id : dealer._id }, { $set : { table_name : tableName } }, { session });
				}
			});

			return dealerChangeData;
		} catch (e) {
			console.log('dealer change failed'.error, e);
			return false;
		}
	},

	/** If round status is P then set to S */
	async fnResetTimer (roundId, tableId, roundNum) {
		let changed;

		try {
			changed = await this.fnSetRoundStatus(roundId, 'S', tableId, roundNum, 'P');
		} catch (e) {
			changed = false;
		}

		if (!changed) {
			throw 'Error: set round status';
		}
	},

	/**
	 * init payload for the socket-servers: every active table that has a road
	 * map, a round and a known dealer for that round (former inner joins),
	 * crossed with the global maintenance (required) and notice (optional).
	 */
	async fnGetTablesMarks (gameName) {
		const [maintenance, notice] = await Promise.all([
			models.maintenance.findOne({}).sort({ _id : -1 }).lean(),
			models.notice.findOne({}).sort({ _id : -1 }).lean()
		]);

		const latest = (from, as) => [
			{
				$lookup : {
					from,
					let      : { tableId : '$_id' },
					pipeline : [
						{ $match : { $expr : { $eq : ['$table_id', '$$tableId'] } } },
						{ $sort : { _id : -1 } },
						{ $limit : 1 }
					],
					as
				}
			},
			{ $unwind : `$${as}` }
		];

		const rows = maintenance ? await models.tables.aggregate([
			{ $match : { game_name : gameName, status : '1' } },
			...latest(models.gameMarks.collection.collectionName, 'marks'),
			...latest(models.rounds.collection.collectionName, 'round'),
			{ $sort : { _id : 1 } }
		]) : [];

		const dealers = _.keyBy(await models.dealers.find(
			{ _id : { $in : _.uniq(_.map(rows, 'round.dealer_id')) } },
			{ name : 1, dealer_image : 1 }
		).lean(), '_id');

		const tables = [];

		_.each(rows, table => {
			const dealer = dealers[table.round.dealer_id];

			if (!dealer) return;

			tables.push({
				id                 : table._id,
				shoeNumber         : table.marks.mark_num,
				roundNum           : table.round.round_num,
				roundStatus        : table.round.status,
				currentDealer      : dealer.name,
				dealerId           : dealer._id,
				dealerImage        : dealer.dealer_image,
				roomType           : table.room_type,
				envSetting         : table.env_setting,
				sportBetRanges     : table.sport_bet_ranges,
				casinoBetRanges    : table.casino_bet_ranges,
				maintenanceSetting : table.maintenance_setting,
				noticeSetting      : table.notice_setting,
				gameInfo           : table.round.game_info,
				gameResult         : table.round.game_result,
				gameMarks          : table.marks.mark
			});
		});

		const mainMaintenance = tables.length ? {
			mainText   : maintenance.main_text,
			subText    : maintenance.sub_text,
			status     : maintenance.status,
			start_time : formatMinute(maintenance.start_time),
			end_time   : formatMinute(maintenance.end_time)
		} : {};

		const mainNotice = tables.length ? {
			start_time : notice ? formatMinute(notice.start_time) : null,
			end_time   : notice ? formatMinute(notice.end_time) : null,
			content    : notice ? notice.content : null,
			time_yn    : notice ? notice.time_yn : null,
			status     : notice ? notice.status : null
		} : {};

		return {
			eventName : 'init',
			gameName,
			mainMaintenance,
			mainNotice,
			tables
		};
	},

	/**
	 * A player left a room (published by the socket-server). Former stored
	 * procedures USP_ROOMS_SAVE('A', ...) / USP_REMOVE_JUNKET_ROOM.
	 */
	async roomDisconnect (data) {
		if (data.type == 'J') {
			await models.rooms.deleteOne({
				vendor_id : data.vendorId,
				name      : `${data.gameType}-${data.tableId}`
			});
		}

		return models.rooms.updateOne(
			{ _id : parseInt(data.roomId) },
			{ $pull : { users : parseInt(data.userId) } }
		);
	},

	async fnGetTables (gameName) {
		const tables = await models.tables.find({}, { _id : 1 }).sort({ _id : 1 }).lean();

		return {
			eventName : 'init',
			gameName,
			tables    : _.map(tables, '_id')
		};
	},

	/** 'card' | 'dealer' | 'shoe' | false */
	async fnCardType (value) {
		value = String(value || '').trim();

		if (new deck(value).checkCard(value)) {
			return 'card';
		}

		try {
			if (await models.dealers.exists({ code : value })) {
				return 'dealer';
			}
		} catch (e) {
			return false;
		}

		return (value.length == 8 && value.startsWith('AA')) ? 'shoe' : false;
	}
}; // end module exports
