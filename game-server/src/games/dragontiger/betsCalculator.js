'use strict';

	/*
	|--------------------------------------------------------------------------
	| BetsCalculator v2.0
	|--------------------------------------------------------------------------
	| Author : Shinji Escorido
	| Processing of bets
	|
	*/

const _      = require('lodash');
const moment = require('moment');
const models = require('./db');
const http   = require('../../core/http');
const conf   = require('../../config');

// bet names a bet_history entry may use (each one is a payout function below)
const BET_TYPES = [
	'tie', 'suited_tie',
	'dragon', 'dragon_odd', 'dragon_even', 'dragon_big', 'dragon_small',
	'dragon_clubs', 'dragon_hearts', 'dragon_diamonds', 'dragon_spades',
	'tiger', 'tiger_odd', 'tiger_even', 'tiger_big', 'tiger_small',
	'tiger_clubs', 'tiger_hearts', 'tiger_diamonds', 'tiger_spades'
];

const utc = date => moment(date).utcOffset(0).format('YYYY-MM-DD HH:mm:ss');

module.exports = {
	BET_TYPES,

	multipliers : {
		dragon : {
			regular : 1, // 1:1
			big     : 1,
			small   : 1,
			odd     : 1,
			even    : 1,
			heart   : 3,
			diamond : 3,
			club    : 3,
			spade   : 3
		},
		tiger : {
			regular : 1,
			big     : 1,
			small   : 1,
			odd     : 1,
			even    : 1,
			heart   : 3,
			diamond : 3,
			club    : 3,
			spade   : 3
		},
		tie : {
			regular : 10, // 10: 1
			suited  : 50 // 50 :1
		}
	},

	/**
	 * Settles every bet of the round (no I/O).
	 *
	 * @param result fnGetResults().result (winner, cards)
	 * @param bets   plain bets with user + user.vendor
	 * @returns { roundWins, userInfo, apiUserInfo, betUpdates, moneyIncs }
	 */
	fnSettle (result, bets) {
		let roundWins     = 0;
		const userInfo    = [];
		const apiUserInfo = [];
		const betUpdates  = [];
		const moneyIncs   = [];

		_.each(bets, bets => {
			const resultBets   = [];
			const data         = _.cloneDeep(bets.bet_history) || [];
			let totalBetAmount = 0;
			let totalWin       = 0;
			let tempp          = 0;
			let winningBet     = 0;
			let betLost        = 0;

			_.each(data, betData => {
				const betName = String(betData.bet).trim();

				if (!BET_TYPES.includes(betName)) {
					throw new Error(`unknown bet "${betName}" in bet ${bets.id}`);
				}

				const win_money = this[betName](result, betData.bet_money);

				totalWin       += win_money;
				totalBetAmount += betData.bet_money;

				if (win_money) {
					betData.win_money = win_money + betData.bet_money;
					winningBet += betData.bet_money;
				}
				else {
					// if player loses
					betLost += betData.bet_money;
				}

				const mainBetFlag = (betData.bet == 'dragon' || betData.bet == 'tiger');

				// on a tie half of the dragon / tiger bets is returned
				if ((result.winner == 'tie' || result.winner == 'suited tie') && !win_money && mainBetFlag) {
					tempp = betData.bet_money / 2;

					betData.win_money = tempp;
					totalWin += tempp;
					betLost -= tempp;
				}

				resultBets.push(betData);
			});

			const totalRolling = totalBetAmount - tempp;
			const moneyForUser = winningBet + totalWin;

			userInfo.push({
				id            : bets.user_id,
				money         : bets.user.money + moneyForUser,
				user_type     : bets.user.user_type,
				total_winning : Math.round(moneyForUser * 100) / 100,
				total_lost    : betLost,
				bets          : data
			});

			bets.created_at = utc(bets.created_at);

			apiUserInfo.push({
				id            : bets.user.id,
				user_id       : bets.user.user_id,
				user_name     : bets.user.user_name,
				vendor_id     : bets.user.vendor_id,
				type          : bets.type,
				user_type     : bets.user.user_type,
				bets          : data,
				bet_range     : bets.bet_range,
				total_bet     : totalBetAmount,
				total_rolling : totalRolling,
				total_win     : moneyForUser,
				total_lost    : betLost,
				bet_id        : bets.bet_id,
				session_id    : bets.session_id,
				created_at    : bets.created_at,
				currency      : bets.currency || bets.user.currency || bets.user.vendor.currency,
				multiplier    : bets.user.denomination || bets.user.vendor.multiplier
			});

			betUpdates.push({
				id   : bets.id,
				set  : {
					bet_history   : resultBets,
					total_bet     : totalBetAmount,
					total_winning : totalWin,
					total_win     : moneyForUser,
					total_lost    : betLost,
					total_rolling : totalRolling
				}
			});

			// seamless vendors keep the money on their side
			if (bets.user.vendor.integration_type == 'transfer') {
				moneyIncs.push({ userId : bets.user_id, amount : moneyForUser });
			}

			roundWins += moneyForUser;
		});

		return { roundWins, userInfo, apiUserInfo, betUpdates, moneyIncs };
	},

	/**
	 * Ends the round: stores the result, settles the bets, credits transfer
	 * users and adds the road map mark, all in one transaction. The round is
	 * flipped to 'E' first, guarded by the status it was read with, so a
	 * second displayresults cannot pay out twice.
	 */
	async processBets (gameResult, result, h, tableId, shoeId, dealerName, roundStatus) {
		result.updated_at = moment().utcOffset(0).format('YYYY-MM-DD HH:mm:ss');
		result.created_at = utc(result.created_at);

		const winValue = result.cards[(result.winner == 'tie' || result.winner == 'suited tie') ? 'dragon' : result.winner].value;
		const markData = this.fnGetCardSideBetMark(
			result.winner,
			winValue,
			result.cards.dragon.value,
			result.cards.tiger.value,
			h
		);
		const gameMarksData = { num : winValue, mark : markData };

		const settled = _.isEmpty(result.bets)
			? { roundWins : 0, userInfo : null, apiUserInfo : [], betUpdates : [], moneyIncs : [] }
			: this.fnSettle(result, result.bets);

		// a resulted, cancelled or voided round is never settled (again)
		if (!['S', 'P', 'H'].includes(roundStatus)) {
			throw new Error(`round ${result.roundId} is '${roundStatus}', not settled`);
		}

		await models.withTransaction(async session => {
			const ended = await models.rounds.updateOne(
				{ _id : result.roundId, status : roundStatus },
				{ $set : { status : 'E', game_result : gameResult } },
				{ session }
			);

			if (!ended.matchedCount) {
				throw new Error(`round ${result.roundId} is no longer '${roundStatus}', not settled`);
			}

			if (settled.betUpdates.length) {
				await models.bets.bulkWrite(settled.betUpdates.map(b => ({
					updateOne : { filter : { _id : b.id }, update : { $set : b.set } }
				})), { session });
			}

			if (settled.moneyIncs.length) {
				await models.users.bulkWrite(settled.moneyIncs.map(m => ({
					updateOne : { filter : { _id : m.userId }, update : { $inc : { money : m.amount } } }
				})), { session });
			}

			// former JSON_ARRAY_INSERT(mark, '$[200]', ...) on the shoe's road map
			// ($position 200 appends while the shoe has fewer marks, like the old insert)
			let markId = shoeId;

			if (!markId) {
				const latest = await models.gameMarks.findOne({ table_id : tableId }, { _id : 1 }, { session }).sort({ _id : -1 }).lean();
				markId = latest && latest._id;
			}

			if (markId) {
				await models.gameMarks.updateOne({ _id : markId }, {
					// round_id: lets a void (admin) take exactly this round's mark off the road map
					$push : { mark : { $each : [Object.assign({ round_id : result.roundId }, gameMarksData)], $position : 200 } }
				}, { session });
			}
		});

		result.gameResult = gameResult;
		this.sendToAPIServer(conf.games.dragontiger.gameName, result, settled.apiUserInfo, dealerName);

		return {
			gameMarksData,
			roundWins : settled.roundWins,
			userInfo  : settled.userInfo
		};
	},

	/**
	 * Pass data for current round to Nihtan API Server (skipped when
	 * API_HISTORY_URL is not set).
	 */
	sendToAPIServer (game, result, data, dealer) {
		if (!conf.apiHistoryUrl) return;

		http.postJson(conf.apiHistoryUrl, {
			game,
			table       : result.tableId,
			round_no    : result.roundNum,
			game_info   : result.gameInfo,
			game_result : result.gameResult,
			created_at  : result.created_at,
			resulted_at : result.updated_at,
			dealer,
			data
		}).catch(e => console.log(`[${game}] history api: ${e.message}`.error));
	},

	checkseven(betName, result) {
		return (result.cards[betName].value == 7);
	},

	tie (result, amount) {
		if (result.winner == 'tie' && amount) {
			 return amount * this.multipliers.tie.regular;
		}
		else if (result.winner == 'suited tie' && amount) {
			 return amount * this.multipliers.tie.regular;
		}

		return 0;
	},

	dragon (result, amount) {
		return (result.winner == 'dragon' && amount) ? amount * this.multipliers.dragon.regular : 0;
	},

	suited_tie (result, amount) {
		let tieOdds = (this.checkseven('dragon', result)) ? this.multipliers.tie.regular : this.multipliers.tie.suited;
		
		return (result.winner == 'suited tie' && amount) ? amount * tieOdds : 0;
	},

	dragon_odd ( result, amount ) {
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.value % 2) && amount) ? amount * this.multipliers.dragon.odd : 0;
	},

	dragon_even (result, amount) {
		// return if dragoncard is even and and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return (!(result.cards.dragon.value % 2) && amount) ? amount * this.multipliers.dragon.even : 0;
	},

	dragon_big (result, amount) {
		// return if dragoncard is greater than 7 and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.value > 7) && amount) ? amount * this.multipliers.dragon.big : 0;
	},

	dragon_small (result, amount) {
		// return if dragoncard is less than 7 and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.value < 7) && amount) ? amount * this.multipliers.dragon.small : 0;
	},

	dragon_clubs (result, amount) {
		// return if dragoncard is club suit and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.suite == 'club') && amount) ? amount * this.multipliers.dragon.club : 0;
	},

	dragon_hearts (result, amount) {
		// return if dragoncard is heart suit and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.suite == 'heart') && amount) ? amount * this.multipliers.dragon.heart : 0;
	},

	dragon_diamonds (result, amount) {
		// return if dragoncard is diamond suit and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.suite == 'diamond') && amount) ? amount * this.multipliers.dragon.diamond : 0;
	},

	dragon_spades (result, amount) {
		// return if dragoncard is spade suit and amount > 0
		if (this.checkseven('dragon', result)) {
			return 0;
		}

		return ((result.cards.dragon.suite == 'spade') && amount) ? amount * this.multipliers.dragon.spade : 0;
	},

/* 					*
 *					*
 * TIGER BETS PHASE *
 *					*
 *					*
 *					*
 *					*/

 	tiger (result, amount) {
		return (result.winner == 'tiger' && amount) ? amount * this.multipliers.tiger.regular : 0;
	},

	tiger_odd (result, amount) {
		// return if tigercard is odd and and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.value % 2) && amount) ? amount * this.multipliers.tiger.odd : 0;
	},

	tiger_even (result, amount) {
		// return if tigercard is even and and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return (!( result.cards.tiger.value % 2) && amount) ? amount * this.multipliers.tiger.even : 0;
	},

	tiger_big (result, amount) {
		// return if tigercard is greater than 7 and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.value > 7) && amount) ? amount * this.multipliers.tiger.big : 0;
	},

	tiger_small (result, amount) {
		// return if tigercard is less than 7 and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.value < 7) && amount) ? amount * this.multipliers.tiger.small : 0;
	},

	tiger_clubs (result, amount) {
		// return if tigercard is club suit and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.suite == 'club') && amount) ? amount * this.multipliers.tiger.club : 0;
	},

	tiger_hearts (result, amount) {
		// return if tigercard is heart suit and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.suite == 'heart') && amount) ? amount * this.multipliers.tiger.heart : 0;
	},

	tiger_diamonds ( result, amount ) {
		// return if tigercard is diamond suit and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.suite == 'diamond') && amount) ? amount * this.multipliers.tiger.diamond : 0;
	},

	tiger_spades (result, amount) {
		// return if tigercard is spade suit and amount > 0
		if (this.checkseven('tiger', result)) {
			return 0;
		}

		return ((result.cards.tiger.suite == 'spade') && amount) ? amount * this.multipliers.tiger.spade : 0;
	},

	fnGetCardSideBetMark(w, wv, dv, tv, h) {
		if (w == 'suited tie') {
			if (dv == 7) {
				w = 'tie';
			}
		}

		let l = (dv > 7) ? '1' : '0';
		let r = (tv > 7) ? '1' : '0';

		return h[w + '.' + l + r];
	}
};
