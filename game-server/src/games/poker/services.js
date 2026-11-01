'use strict';

/*
 |--------------------------------------------------------------------------
 | poker services
 |--------------------------------------------------------------------------
 | Data layer of the poker (casino hold'em vs dealer) game server: rounds,
 | cards, results and bet settlement on MongoDB.
 |
 | Payout / bonus rules are unchanged from the MySQL implementation.
 |
 */

const _      = require('lodash');
const moment = require('moment');
const { Hand } = require('pokersolver');
const deck   = require('./cardsModule');
const models = require('./db');
const http   = require('../../core/http');
const config = require('../../config');

const GAME_NAME = config.games.poker.gameName;

// "YYYY-MM-DD HH:mm:00" like the former DATE_FORMAT(..., '%Y-%m-%d %H:%i:00'); null stays null
const minuteFormat = date => (date ? moment(date).format('YYYY-MM-DD HH:mm:00') : null);

const utcFormat = date => moment(date || undefined).utcOffset(0).format('YYYY-MM-DD HH:mm:ss');

// game_marks.mark is stored as a one element array (schema is [Mixed]); payloads carry the object
const markOf = doc => (Array.isArray(doc.mark) ? doc.mark[0] : doc.mark);

// fields of game_info that may be written by inputitem / removeitem
const CARD_FIELD = /^[a-z]+$/i;

const bonusplusBet = bh => (bh.bonusplus ? bh.bonusplus.bet : 0);

module.exports = {
	payoutHandler : {
		player (data) {
			const anteBonusOdds       = data.anteBonusOdds;
			const anteBonusPlusAmount = +data.anteBonusPlusAmount || 0; // bp
			const bh          = data.bh;
			const bonusAmount = data.bonusAmount;
			const bonus       = data.bonus;

			let totalWin     = 0;
			const totalBet   = bh.ante.bet + bh.flop.bet + bh.turn.bet + bh.river.bet + bh[bonus].bet + bonusplusBet(bh);
			let lostBet      = 0;
			let totalWinning = bh.flop.bet + bh.turn.bet + bh.river.bet;
			let totalRolling = totalBet;
			let totalLost    = 0;

			bh.flop.win  = bh.flop.bet * 2;
			bh.turn.win  = bh.turn.bet * 2;
			bh.river.win = bh.river.bet * 2;

			if (anteBonusOdds) {
				bh.ante.win = bh.ante.bet * 2;
				totalWinning += bh.ante.bet;
			} else {
				bh.ante.win = bh.ante.bet;
				totalRolling = totalRolling - bh.ante.bet;
			}

			if (bonusAmount) {
				const bonusWin = bh[bonus].bet * bonusAmount;
				bh[bonus].win = bonusWin + bh[bonus].bet;
				totalWinning += bonusWin;
			} else {
				lostBet = bh[bonus].bet;
			}

			if (anteBonusPlusAmount && bonus == 'pocket' && bh.bonusplus) {
				const bonusPlusWin = bh.bonusplus.bet * anteBonusPlusAmount;
				bh.bonusplus.win = bonusPlusWin + bh.bonusplus.bet;
				totalWinning += bonusPlusWin;
			} else {
				lostBet += bonusplusBet(bh);
			}

			totalWin  = totalBet + totalWinning - lostBet;
			totalLost = lostBet;

			return { totalWin, totalLost, totalBet, totalWinning, totalRolling, bh };
		},

		tie (data) {
			const bh                  = data.bh;
			const bonusAmount         = data.bonusAmount;
			const anteBonusPlusAmount = +data.anteBonusPlusAmount || 0; // bp
			const bonus               = data.bonus;

			const totalBet   = bh.ante.bet + bh.flop.bet + bh.turn.bet + bh.river.bet + bh[bonus].bet + bonusplusBet(bh);
			let totalWin     = totalBet - bh[bonus].bet - bonusplusBet(bh);
			let totalWinning = 0;
			let totalRolling = 0;
			let totalLost    = 0;

			if (bonusAmount) {
				const bonusWin = bh[bonus].bet * bonusAmount;
				totalWinning += bonusWin;
				bh[bonus].win = bonusWin + bh[bonus].bet;
				totalWin += bh[bonus].bet; // if bonus win, then bonus bet is refunded also
				totalRolling = bh[bonus].bet;
			} else {
				totalLost = bh[bonus].bet;
				totalRolling = bh[bonus].bet;
			}

			if (anteBonusPlusAmount && bonus == 'pocket' && bh.bonusplus) {
				const bonusPlusWin = bh.bonusplus.bet * anteBonusPlusAmount;
				totalWinning += bonusPlusWin;
				bh.bonusplus.win = bonusPlusWin + bh.bonusplus.bet;
				totalWin += bh.bonusplus.bet; // if bonus win, then bonus bet is refunded also
				totalRolling += bh.bonusplus.bet;
			} else {
				totalLost += bonusplusBet(bh);
				totalRolling += bonusplusBet(bh);
			}

			totalWin += totalWinning;

			bh.ante.win  = bh.ante.bet;
			bh.flop.win  = bh.flop.bet;
			bh.turn.win  = bh.turn.bet;
			bh.river.win = bh.river.bet;

			return { totalWin, totalLost, totalBet, totalWinning, totalRolling, bh };
		},

		dealer (data) {
			const bh                  = data.bh;
			const bonusAmount         = data.bonusAmount;
			const anteBonusPlusAmount = +data.anteBonusPlusAmount || 0; // bp
			const bonus               = data.bonus;

			const totalBet     = bh.ante.bet + bh.flop.bet + bh.turn.bet + bh.river.bet + bh[bonus].bet + bonusplusBet(bh);
			let totalWin       = 0;
			let totalWinning   = 0;
			const totalRolling = totalBet;
			let totalLost      = bh.ante.bet + bh.flop.bet + bh.turn.bet + bh.river.bet;

			if (bonusAmount) {
				const bonusWin = bh[bonus].bet * bonusAmount;
				bh[bonus].win = bonusWin + bh[bonus].bet;
				totalWinning += bonusWin;
				totalWin += bh[bonus].bet;
			} else {
				totalLost += bh[bonus].bet;
			}

			if (anteBonusPlusAmount && bonus == 'pocket' && bh.bonusplus) {
				const bonusPlusWin = bh.bonusplus.bet * anteBonusPlusAmount;
				bh.bonusplus.win = bonusPlusWin + bh.bonusplus.bet;
				totalWinning += bonusPlusWin;
				totalWin += bh.bonusplus.bet;
			} else {
				totalLost += bonusplusBet(bh);
			}

			totalWin += totalWinning;

			return { totalWin, totalLost, totalBet, totalWinning, totalRolling, bh };
		}
	},

	/** pokersolver cards -> ['AH', 'TD', ...] */
	getCards (cards) {
		const names = { '1' : 'A', '10' : 'T', '11' : 'J', '12' : 'Q', '13' : 'K' };
		return _.map(cards, c => {
			const value = (c.value == 1 || c.value > 9) ? names[c.value.toString()] : c.value;
			return value + c.suit.toUpperCase();
		});
	},

	/** barcodes ('0013') -> card names ('AH') */
	convertInput (card) {
		const names = hand => _.map(hand, c => deck(c).name);

		return {
			turn   : deck(card.turn).name,
			river  : deck(card.river).name,
			player : names(card.player),
			flop   : names(card.flop),
			burn   : names(card.burn),
			dealer : names(card.dealer)
		};
	},

	/**
	 * Evaluates both hands of a fully dealt round (game_info with barcodes).
	 * Throws a string (like the former rejections) when cards are missing.
	 */
	evaluateHands (gameInfoCodes) {
		const card = this.convertInput(gameInfoCodes || {});

		if (!card.river) throw 'river empty';

		const fivePlayerSet    = [...card.player, ...card.flop];
		const unifiedPlayerSet = _.union(card.player, card.flop, [card.turn], [card.river]);
		const unifiedBankerSet = _.union(card.dealer, card.flop, [card.turn], [card.river]);

		if (unifiedPlayerSet.length != 7 || unifiedBankerSet.length != 7) throw 'insufficient cards';

		const player5Hands = Hand.solve(fivePlayerSet);
		const playerHands  = Hand.solve(unifiedPlayerSet);
		const bankerHands  = Hand.solve(unifiedBankerSet);
		const winner       = Hand.winners([playerHands, bankerHands]);
		const handtype     = (winner[0].descr == 'Royal Flush') ? winner[0].descr : winner[0].name;

		let winSide = 'dealer';
		if (winner.length > 1) winSide = 'tie';
		else if (_.isEqual(playerHands, winner[0])) winSide = 'player';

		return { card, player5Hands, playerHands, bankerHands, winner, handtype, winSide };
	},

	cardCode (name) {
		return deck('0000').getCodeByName(name).code;
	},

	async fnGetCurrentRoundDatas (tableId) {
		const data = await models.rounds.findOne({ table_id : tableId })
			.sort({ _id : -1 })
			.select('game_info round_num game_result status table_id dealer_id')
			.populate({ path : 'dealer', select : 'real_name name dealer_image' })
			.populate({ path : 'table', select : 'bet_setting env_setting' })
			.lean()
			.catch(() => Promise.reject('server error: refresh the page'));

		if (!data) throw 'cant find current round: refresh the app';
		if (!data.table) throw 'server error: refresh the page';

		const rawGameInfo = data.game_info || {};
		const betSettings = data.table.bet_setting || {};
		const envSetting  = data.table.env_setting || {};
		const done        = data.game_result;
		const gameInfo    = this.convertInput(rawGameInfo);
		let postStatus    = data.status;

		// get post status logic
		if (data.status == 'H') {
			if (data.game_result) {
				postStatus = 'E';
			} else if (!gameInfo.player) {
				postStatus = 'S';
			} else {
				postStatus = 'P';
			}
		}

		const markData = await models.gameMarks.findOne({ table_id : data.table_id }, { mark_num : 1 })
			.sort({ created_at : -1, _id : -1 })
			.lean()
			.catch(() => Promise.reject('server error: refresh the page'));

		const dealer = data.dealer ? {
			id           : data.dealer._id,
			real_name    : data.dealer.real_name,
			name         : data.dealer.name,
			dealer_image : data.dealer.dealer_image
		} : null;

		return {
			roundId       : data._id,
			roundNum      : data.round_num,
			dealer,
			autonextround : (betSettings.auto_next_round == 'Y') ? betSettings.delay_time : 0,
			bettimer      : betSettings.betting_time || 0,
			lastrounds    : betSettings.lastrounds,
			player        : gameInfo.player ? gameInfo.player : null,
			banker        : gameInfo.dealer ? gameInfo.dealer : null,
			flop          : gameInfo.flop ? gameInfo.flop : null,
			turn          : gameInfo.turn,
			river         : gameInfo.river,
			burn          : gameInfo.burn ? gameInfo.burn : null,
			gameInfo      : _.cloneDeep(rawGameInfo),
			table         : data.table._id,
			status        : data.status,
			rtmp          : envSetting.web_stream,
			postStatus,
			shoe          : (markData && markData.mark_num != null) ? markData.mark_num : null,
			done,
			tableId
		};
	},

	async fnProcessNewRound (currentTableId, dealerId, roundNum) {
		const round = await models.rounds.create({
			_id       : await models.nextId('rounds'),
			dealer_id : dealerId,
			game_info : { dealer : [], player : [], flop : [], river : null, turn : null, burn : [] },
			round_num : parseInt(roundNum) + 1,
			table_id  : currentTableId,
			status    : 'S'
		});

		return { id : round._id, round_num : round.round_num };
	},

	async getCardType (data) {
		if (deck(data).checkCard(data)) return 'card'; // checks if data is from game cards
		if (typeof data === 'string' && data.length == 5 && data[0] == 'D') return 'dealer';
		throw 'unrecognized card';
	},

	async fnProcessDeleteCard (who, tableId, roundNum) {
		const round = await models.rounds.findOne({ table_id : tableId, round_num : roundNum }).lean()
			.catch(() => Promise.reject('Error: delete card, please refresh'));

		if (!round) throw 'cant find round: refresh the app';

		const gameInfo = round.game_info || {};

		if (gameInfo[who] instanceof Array) {
			if ((who == 'player' || who == 'dealer') && gameInfo[who].length > 2) {
				gameInfo[who] = [];
			} else if (who == 'flop' && gameInfo[who].length > 3) {
				gameInfo[who] = [];
			} else {
				gameInfo[who].pop();
			}
		} else {
			gameInfo[who] = null;
		}

		await models.rounds.updateOne({ _id : round._id }, { $set : { game_info : gameInfo, status : 'P' } })
			.catch(() => Promise.reject('update error: refresh the app'));

		return gameInfo;
	},

	/**
	 * Stores a scanned card. Same semantics as the former
	 *   JSON_SET(game_info, "$.<type>", value)       (turn / river)
	 *   JSON_SET(game_info, "$.<type>[2]", value)    (hands: appends while the
	 *                                                 array has < 3 cards, else replaces the 3rd)
	 * done atomically with an update pipeline.
	 */
	fnProcessCard (value, type, roundNum, tableId, next) {
		if (typeof type !== 'string' || !CARD_FIELD.test(type)) {
			next({ error : true });
			return;
		}

		const path  = `game_info.${type}`;
		const field = `$${path}`;
		let update;

		if (type == 'turn' || type == 'river') {
			update = { $set : { [path] : value } };
		} else {
			const card = [{ $literal : value }];
			update = [{ $set : { [path] : { $cond : [
				{ $isArray : field },
				{ $cond : [
					{ $gt : [{ $size : field }, 2] },
					{ $concatArrays : [{ $slice : [field, 2] }, card, { $slice : [field, 3, { $max : [{ $subtract : [{ $size : field }, 3] }, 1] }] }] },
					{ $concatArrays : [field, card] }
				] },
				field
			] } } }];
		}

		models.rounds.updateOne({ round_num : roundNum, table_id : tableId }, update)
			.then(() => next(true))
			.catch(() => next({ error : true }));
	},

	/**
	 * If round status is P then set it back to S.
	 */
	async fnResetTimer (roundNum, tableId) {
		const r = await models.rounds.updateOne(
			{ round_num : roundNum, table_id : tableId, status : 'P' },
			{ $set : { status : 'S' } }
		).catch(() => Promise.reject('Error: set round status'));

		if (!r.matchedCount) throw 'Error: set round status';
	},

	changeDealer (value, roundNum, roundId, realName, tableId, gameName, status, next) {
		const failed = () => next({ error : true, message : 'server error: refresh the app' });

		models.dealers.findOne({ code : value }, 'real_name name code dealer_image table_image').lean()
			.then(async dealer => {
				if (!dealer) return failed();

				const dealerChangeData = {
					gameName,
					roundId,
					roundNum,
					eventName   : 'dealerchange',
					tableId,
					dealerId    : dealer._id,
					dealerCode  : dealer.code,
					dealerName  : dealer.name,
					dealerImage : dealer.dealer_image,
					tableImage  : dealer.table_image
				};

				if (status != 'S') return next(dealerChangeData);

				const tableName = `${gameName}# ${tableId}`;

				await models.withTransaction(async session => {
					// 1. the previous dealer of this table loses the table name
					await models.dealers.updateMany({ table_name : tableName }, { $set : { table_name : null } }, { session });

					// 2. UPDATE rounds JOIN dealers: both rows only change when the round exists
					const r = await models.rounds.updateOne(
						{ table_id : tableId, round_num : roundNum },
						{ $set : { dealer_id : dealer._id } },
						{ session }
					);
					if (r.matchedCount) {
						await models.dealers.updateOne({ _id : dealer._id }, { $set : { table_name : tableName } }, { session });
					}
				});

				next(dealerChangeData);
			})
			.catch(failed);
	},

	/**
	 * @param rank       pokersolver descr of the player's 5 card hand
	 * @param isBadBeat  1 when the dealer won
	 */
	getAnteBonus (rank, isBadBeat) {
		// this function is for ante bonus feature
		const n = rank.split(',')[0].toLowerCase().trim();

		const rankDataler = {
			'royal flush'    : [500, 500], // rank = royal flush always wins.
			'straight flush' : [50, 500],
			'four of a kind' : [10, 50],
			'full house'     : [3, 10],
			'flush'          : [1.5, 8],
			'straight'       : [1, 5]
		};

		return rankDataler[n] ? rankDataler[n][isBadBeat] || 0 : 0;
	},

	/** 1 when the player's hand is a straight or better (ante pays 1:1), else 0 (ante push) */
	getAntePayoutOdds (rank) {
		const n = rank.split(',')[0].toLowerCase().trim();
		return ['royal flush', 'straight flush', 'four of a kind', 'full house', 'flush', 'straight'].includes(n) ? 1 : 0;
	},

	async fnGetPartialResults (roundId, roundNum, tableId) {
		const round = await models.rounds.findOne({ round_num : roundNum, table_id : tableId }).lean()
			.catch(() => Promise.reject('server error at find results'));

		if (_.isEmpty(round)) throw 'round empty';

		const cardCodes = _.cloneDeep(round.game_info);
		const { playerHands, bankerHands, winner, winSide, handtype } = this.evaluateHands(round.game_info);
		const cards  = this.getCards(winner[0].cards);
		const uCards = _.map(_.take(cards, 5), c => this.cardCode(c));

		return {
			created_at : round.created_at,
			updated_at : round.updated_at,
			tableId    : round.table_id,
			roundId    : round._id,
			roundNum   : round.round_num,
			playerHands,
			bankerHands,
			winner,
			winSide,
			gameInfo   : cardCodes,
			gameResult : {
				cards,
				cardsCode : uCards,
				winner    : winSide,
				handtype
			}
		};
	},

	/** bet document -> the shape the former Sequelize instance serialised to */
	betPayload (bet) {
		const user   = bet.user || null;
		const vendor = user && user.vendor;
		return {
			id            : bet._id,
			round_id      : bet.round_id,
			type          : bet.type,
			user_id       : bet.user_id,
			bet_history   : JSON.stringify(bet.bet_history),
			total_bet     : bet.total_bet,
			total_winning : bet.total_winning,
			bet_range     : bet.bet_range,
			created_at    : bet.created_at,
			updated_at    : bet.updated_at,
			session_id    : bet.session_id,
			bet_id        : bet.bet_id,
			currency      : bet.currency,
			user          : user && {
				id           : user._id,
				vendor_id    : user.vendor_id,
				user_id      : user.user_id,
				user_name    : user.user_name,
				money        : user.money,
				user_type    : user.user_type,
				currency     : user.currency,
				denomination : user.denomination,
				vendor       : vendor ? {
					id               : vendor._id,
					type             : vendor.type,
					integration_type : vendor.integration_type,
					currency         : vendor.currency,
					multiplier       : vendor.multiplier
				} : null
			}
		};
	},

	/**
	 * Computes the result of the round in progress (status P). Read only:
	 * the round is ended and the marks / bets / money are written in one
	 * transaction by processBets().
	 */
	async fnGetResults (roundId, roundNum, tableId) {
		const round = await models.rounds.findOne({ round_num : roundNum, table_id : tableId, status : 'P' })
			.populate({
				path     : 'bets',
				populate : {
					path     : 'user',
					select   : 'vendor_id user_id user_name money user_type currency denomination',
					populate : { path : 'vendor', select : 'type integration_type currency multiplier' }
				}
			})
			.lean()
			.catch(e => {
				console.log('server error at find results', e);
				return Promise.reject('server error at find results');
			});

		if (_.isEmpty(round)) throw 'round empty';

		const cardCodes = _.cloneDeep(round.game_info);
		const { card, player5Hands, playerHands, bankerHands, winner, winSide, handtype } = this.evaluateHands(round.game_info);

		// convert barcodes to poker-solver readables
		const playerBonusHand = card.player;
		const bets            = round.bets || [];
		const playerCardRank  = this.getAntePayoutOdds(playerHands.descr);

		// include extra cards for tie
		const cards = _.union(this.getCards(winner[0].cards), winner.length > 1 ? this.getCards(winner[1].cards) : []);

		const bonusplusAmount = this.getAnteBonus(player5Hands.descr, +(winSide == 'dealer'));
		const uCards = [];
		_.each(cards, (c, ind) => {
			if (ind < 5 || (ind >= 5 && winner.length > 1)) uCards.push(this.cardCode(c));
		});

		const currentResults = { cards : uCards, winner : winSide, handtype };
		const finalResult = { game_result : currentResults, status : 'E' };
		const mark = { mark : winSide[0].toUpperCase() };

		const lastrounds = await models.rounds.find({ table_id : tableId }, 'round_num status game_info game_result')
			.sort({ _id : -1 }).limit(3).lean()
			.catch(() => Promise.reject('server error at meta results'));

		const meta = _.map(lastrounds, lround => ({
			roundId    : lround._id,
			roundNum   : lround.round_num,
			gameInfo   : Object.assign({}, lround.game_info, lround.status === 'W' ? { isVoid : true } : {}),
			// the current round is not resulted in the db yet
			gameResult : (lround._id !== round._id && lround.game_result) ? lround.game_result : currentResults
		}));

		return {
			created_at : round.created_at,
			updated_at : new Date(), // resulted at
			tableId    : round.table_id,
			roundId    : round._id,
			roundNum   : round.round_num,
			playerHands,
			bankerHands,
			winner,
			winSide,
			bets       : _.map(bets, b => this.betPayload(b)),
			rawBets    : bets,
			playerBonusHand,
			playerCardRank,
			bonusplusAmount,
			gameInfo   : cardCodes,
			gameResult : {
				cards,
				cardsCode : uCards,
				winner    : winSide,
				handtype
			},
			finalResult,
			mark,
			meta
		};
	},

	async fnGetTables (gameName) {
		const tables = await models.tables.find({}, { _id : 1 }).sort({ _id : 1 }).lean();
		return {
			eventName : 'init',
			gameName,
			tables    : _.map(tables, '_id')
		};
	},

	async fnGetRoundStatus (roundNum, tableId) {
		const round = await models.rounds.findOne({ table_id : tableId, round_num : roundNum }, 'status').lean()
			.catch(() => null);
		if (!round) throw 'Error: get round status';
		return round.status;
	},

	async fnSetRoundStatus (roundNum, status, tableId) {
		// a resulted, cancelled or voided round is never reopened
		await models.rounds.updateOne({ round_num : roundNum, table_id : tableId, status : { $in : ['S', 'P', 'H'] } }, { $set : { status } });
	},

	async fnProcessAutoNextRound (searchId) {
		const table = await models.tables.findById(searchId, 'bet_setting').lean();
		if (!table) throw 'table not found';

		const settings = table.bet_setting || {};
		settings.auto_next_round = (settings.auto_next_round == 'Y') ? 'N' : 'Y';

		await models.tables.updateOne({ _id : table._id }, { $set : { bet_setting : settings } });

		return (settings.auto_next_round == 'Y') ? settings.delay_time : 0;
	},

	/**
	 * Pass data for the current round to the Nihtan API server (skipped when
	 * API_HISTORY_URL is not configured).
	 */
	sendToAPIServer (game, result, data, dealer) {
		if (!config.apiHistoryUrl) return;

		http.postJson(config.apiHistoryUrl, {
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

	/**
	 * Computes every bet's payout, then in ONE transaction:
	 *  - ends the round (P -> E, game_result); aborts when it is not P anymore
	 *    so a round can never be paid twice
	 *  - writes the road map mark of the round
	 *  - writes the bets' results
	 *  - credits the winnings of transfer-wallet users (seamless vendors keep
	 *    their money on the vendor side)
	 *
	 * @param settle { roundId, finalResult, mark } from fnGetResults
	 */
	async processBets (roundNum, tableId, winner, bets, bonusAmount, pocketAmount, anteBonusOdds, anteBonusPlusAmount, result, dealerName, settle) {
		const userInfo    = [];
		const apiUserInfo = [];
		const betOps      = [];
		const credits     = {}; // user id -> money to add
		let roundWins     = 0;

		result.updated_at = utcFormat(result.updated_at);
		result.created_at = utcFormat(result.created_at);

		_.each(bets, bet => {
			const user  = bet.user;
			if (!user) throw new Error(`user ${bet.user_id} of bet ${bet._id} not found`);

			const bh    = _.cloneDeep(bet.bet_history);
			const bonus = bet.type == 'b' ? 'pocket' : 'bonus';
			const bonusAmountUsed = bet.type == 'b' ? pocketAmount : bonusAmount;
			const totalBet = bh.ante.bet + bh.flop.bet + bh.turn.bet + bh.river.bet + bh[bonus].bet + bonusplusBet(bh);

			// get payouts on winning cases
			const resultHolder = this.payoutHandler[winner]({
				bh,
				bonusAmount : bonusAmountUsed,
				anteBonusOdds,
				anteBonusPlusAmount,
				bonus
			});

			bh.ante.user_money  = bh.ante.user_money || 0;
			bh.flop.user_money  = bh.flop.user_money || 0;
			bh.turn.user_money  = bh.turn.user_money || 0;
			bh.river.user_money = bh.river.user_money || 0;

			let totalUserMoney = user.money + resultHolder.totalWin;

			if (bh.flop.bet < 1) {
				// user folded
				if (bonus == 'pocket' && resultHolder.bh.bonusplus) resultHolder.bh.bonusplus.win = 0;
				resultHolder.bh.ante.win    = 0;
				resultHolder.bh.flop.win    = 0;
				resultHolder.bh.turn.win    = 0;
				resultHolder.bh.river.win   = 0;
				resultHolder.bh[bonus].win  = 0;
				resultHolder.totalWinning   = 0;
				resultHolder.totalWin       = 0;
				resultHolder.totalRolling   = totalBet;
				resultHolder.totalLost      = totalBet;
				totalUserMoney = user.money;
			}

			const vendor = user.vendor || {};
			if (vendor.integration_type == 'transfer' && resultHolder.totalWin) {
				credits[bet.user_id] = (credits[bet.user_id] || 0) + resultHolder.totalWin;
			}

			betOps.push({ updateOne : {
				// only if the bet is unchanged since it was read: street bets (flop / turn /
				// river) are placed while the round is in progress, a bet stored in between
				// must not be overwritten with a payout computed from the stale copy
				filter : { _id : bet._id, updated_at : bet.updated_at },
				update : { $set : {
					bet_history   : resultHolder.bh,
					total_bet     : resultHolder.totalBet,
					total_winning : resultHolder.totalWinning, // raw money won
					total_win     : resultHolder.totalWin,     // money won including the bets
					total_lost    : resultHolder.totalLost,
					total_rolling : resultHolder.totalRolling
				} }
			} });

			userInfo.push({
				id            : bet.user_id,
				total_winning : Math.round(resultHolder.totalWin * 100) / 100,
				money         : totalUserMoney,
				user_type     : user.user_type,
				total_lost    : resultHolder.totalLost,
				bets          : bh,
				type          : bet.type
			});

			apiUserInfo.push({
				id            : user._id,
				user_id       : user.user_id,
				user_name     : user.user_name,
				vendor_id     : user.vendor_id,
				type          : bet.type,
				user_type     : user.user_type,
				bets          : bh,
				bet_range     : bet.bet_range,
				total_bet     : totalBet,
				total_rolling : resultHolder.totalRolling,
				total_win     : resultHolder.totalWin,
				total_lost    : resultHolder.totalLost,
				bet_id        : bet.bet_id,
				session_id    : bet.session_id,
				created_at    : utcFormat(bet.created_at),
				currency      : bet.currency || user.currency || vendor.currency,
				multiplier    : user.denomination || vendor.multiplier
			});

			roundWins += resultHolder.totalWin;
		});

		await models.withTransaction(async session => {
			const ended = await models.rounds.updateOne(
				{ _id : settle.roundId, table_id : tableId, round_num : roundNum, status : 'P' },
				{ $set : settle.finalResult },
				{ session }
			);
			if (!ended.matchedCount) throw new Error(`round ${settle.roundId} is not in progress anymore (already resulted?)`);

			// one road map entry per round (former insertOrUpdate on unique (round_id, table_id))
			const markFilter = { table_id : tableId, round_id : settle.roundId };
			const existing   = await models.gameMarks.findOne(markFilter, { _id : 1 }, { session }).lean();
			if (existing) {
				await models.gameMarks.updateOne({ _id : existing._id }, { $set : { mark : [settle.mark] } }, { session });
			} else {
				await models.gameMarks.create([Object.assign({
					_id      : await models.nextId('game_marks', session),
					mark     : [settle.mark],
					mark_num : null
				}, markFilter)], { session });
			}

			if (betOps.length) {
				const written = await models.bets.bulkWrite(betOps, { session });
				if (written.matchedCount !== betOps.length) {
					// aborts the transaction: the round stays 'P' and nothing is paid
					throw new Error('bets changed while resulting the round, send displayresults again');
				}
			}

			const userOps = _.map(credits, (amount, userId) => ({ updateOne : {
				filter : { _id : parseInt(userId) },
				update : { $inc : { money : amount } }
			} }));
			if (userOps.length) await models.users.bulkWrite(userOps, { session });
		});

		this.sendToAPIServer(GAME_NAME, result, apiUserInfo, dealerName);

		return { roundWins, userInfo };
	},

	/**
	 * init payload: every active table that has road map marks, with its
	 * latest 150 marks (former UNION of LEFT JOINs filtered on mark id IS NOT
	 * NULL, i.e. inner join game_tables -> rounds -> game_marks).
	 */
	async fnGetTablesMarks (gameName) {
		const [tables, maintenance, notice] = await Promise.all([
			models.tables.find({ status : '1' }).sort({ _id : 1 }).lean(),
			models.maintenance.findOne().sort({ _id : 1 }).lean(),
			models.notice.findOne().sort({ _id : 1 }).lean()
		]);

		const m = maintenance || {};
		const n = notice || {};
		const tableGroups = [];

		for (const table of tables) {
			const marks = await models.gameMarks.find({ table_id : table._id }).sort({ _id : -1 }).limit(150).lean();
			if (!marks.length) continue;

			const rounds = await models.rounds.find({ table_id : table._id, _id : { $in : _.map(marks, 'round_id') } }).lean();
			const roundById = _.keyBy(rounds, '_id');

			const rows = _.sortBy(marks.filter(mark => roundById[mark.round_id]), '_id');
			if (!rows.length) continue;

			// table level values come from the round of the latest mark
			const last   = roundById[_.last(rows).round_id];
			const dealer = last.dealer_id != null
				? await models.dealers.findById(last.dealer_id, 'real_name dealer_image').lean()
				: null;
			const betSetting = table.bet_setting || {};
			const slave = (betSetting.type && typeof betSetting.type == 'object') ? betSetting.type[1] : betSetting.type;

			tableGroups.push({
				id                 : table._id,
				roundNum           : last.round_num,
				dealerId           : dealer ? dealer._id : null,
				dealerName         : dealer ? dealer.real_name : null,
				currentDealer      : dealer ? dealer.real_name : null,
				dealerImage        : dealer ? dealer.dealer_image : null,
				envSetting         : table.env_setting,
				betSetting         : table.bet_setting,
				roomType           : table.room_type,
				sportBetRanges     : table.sport_bet_ranges,
				casinoBetRanges    : table.casino_bet_ranges,
				maintenanceSetting : table.maintenance_setting,
				noticeSetting      : table.notice_setting,
				gameInfo           : last.status === 'W' ? Object.assign({}, last.game_info, { isVoid : true }) : last.game_info,
				gameResult         : last.game_result,
				roundStatus        : last.status,
				gameMarks          : _.map(rows, markOf),
				slave
			});
		}

		// the global maintenance / notice were read from the first joined row (none without tables)
		const hasRows = tableGroups.length > 0;

		return {
			eventName       : 'init',
			gameName,
			mainMaintenance : !hasRows ? {} : {
				mainText  : m.main_text,
				subText   : m.sub_text,
				status    : m.status,
				startTime : minuteFormat(m.start_time),
				endTime   : minuteFormat(m.end_time)
			},
			mainNotice      : !hasRows ? {} : {
				start_time : minuteFormat(n.start_time),
				end_time   : minuteFormat(n.end_time),
				content    : n.content,
				time_yn    : n.time_yn,
				status     : n.status
			},
			tables          : tableGroups
		};
	}
};
