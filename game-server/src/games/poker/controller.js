'use strict';

/*
 |--------------------------------------------------------------------------
 | poker controller
 |--------------------------------------------------------------------------
 | Relays the dealer's actions (`push` events) to the dealer socket (acks)
 | and to the socket-servers (redis `game-servers`).
 |
 */

const deck         = require('./cardsModule');
const services     = require('./services');
const models       = require('./db');
const publisher    = require('../../core/publisher');
const logger       = require('../../core/logger');
const errorHandler = require('../../core/errorHandler')(models);
const tableControl = require('../../core/tableControl');

const freshGameInfo = () => ({
	burn   : [],
	player : [],
	dealer : [],
	flop   : [],
	turn   : null,
	river  : null
});

// acked after inputitem / removeitem
const roundAck = dataRow => ({
	roundId       : parseInt(dataRow.roundId),
	status        : dataRow.status,
	postStatus    : dataRow.postStatus,
	tableId       : parseInt(dataRow.tableId),
	dealer        : dataRow.dealer,
	player        : dataRow.player,
	turn          : dataRow.turn,
	betTimer      : parseInt(dataRow.bettimer),
	river         : dataRow.river,
	banker        : dataRow.banker,
	flop          : dataRow.flop,
	burn          : dataRow.burn,
	autonextround : dataRow.autonextround
});

// refreshes the socket round state from the db
const applyRound = (dealerSocket, dataRow) => {
	dealerSocket.roundId    = parseInt(dataRow.roundId);
	dealerSocket.roundNum   = parseInt(dataRow.roundNum);
	dealerSocket.status     = dataRow.status;
	dealerSocket.postStatus = dataRow.postStatus;
	dealerSocket.dealerId   = dataRow.dealer ? parseInt(dataRow.dealer.id) : null;
	dealerSocket.realName   = dataRow.dealer ? dataRow.dealer.real_name : null;
	dealerSocket.bettimer   = parseInt(dataRow.bettimer);
	dealerSocket.shoeId     = dataRow.shoe;
};

const errorMessage = e => (e instanceof Error ? e.message : e);

module.exports = {
	// table id -> dealer currently assigned (survives dealer page reloads)
	dealerStorage : {},

	publish (data) {
		publisher.publish(data);
	},

	fnDealerListener (dealerSocket) {
		dealerSocket.on('push', (data, next) => {
			next = (typeof next === 'function') ? next : (() => {});
			if (!data || typeof data !== 'object') {
				next({ error : true, message : 'invalid event' });
				return;
			}

			const handler = this.handlers[data.event];
			if (!handler) return;

			Promise.resolve()
				.then(() => handler.call(this, dealerSocket, data, next))
				.catch(e => {
					errorHandler(dealerSocket, `${errorMessage(e)} - ${data.event}`);
					next({ error : true, message : errorMessage(e) || 'server error' });
				});
		});
	},

	handlers : {
		async init (dealerSocket, data, next) {
			let dataRow;
			try {
				dataRow = await services.fnGetCurrentRoundDatas(data.data);
				if (!dataRow.dealer) throw 'no dealer assigned to the current round';
			} catch (err) {
				errorHandler(dealerSocket, `${errorMessage(err)} - ${data.event}`);
				next({ error : true, message : errorMessage(err) });
				return;
			}

			if (!this.dealerStorage[data.data]) {
				this.dealerStorage[data.data] = {
					dealerId    : dataRow.dealer.id,
					realName    : dataRow.dealer.real_name,
					name        : dataRow.dealer.name,
					dealerImage : dataRow.dealer.dealer_image
				};
			}
			const stored = this.dealerStorage[data.data];

			dataRow.dealer.dealer_image = stored.dealerImage;
			dealerSocket.roundId    = parseInt(dataRow.roundId);
			dealerSocket.roundNum   = parseInt(dataRow.roundNum);
			dealerSocket.status     = dataRow.status;
			dealerSocket.postStatus = dataRow.postStatus;
			dealerSocket.tableId    = data.data;
			dealerSocket.dealerId   = dataRow.dealer.id = stored.dealerId;
			dealerSocket.realName   = dataRow.dealer.real_name = stored.realName;
			dealerSocket.name       = dataRow.dealer.name = stored.name;
			dealerSocket.dealerName = dealerSocket.name;
			dealerSocket.bettimer   = parseInt(dataRow.bettimer);
			dealerSocket.shoeId     = dataRow.shoe;
			dealerSocket.gameInfo   = dataRow.gameInfo;

			logger.show('CONNECT', dealerSocket).catch(() => console.log('--socket connected'));

			next({
				roundId       : parseInt(dataRow.roundId),
				roundNum      : parseInt(dataRow.roundNum),
				status        : dataRow.status,
				postStatus    : dataRow.postStatus,
				tableId       : parseInt(dataRow.tableId),
				dealer        : dataRow.dealer,
				player        : dataRow.player,
				turn          : dataRow.turn,
				betTimer      : parseInt(dataRow.bettimer),
				river         : dataRow.river,
				banker        : dataRow.banker,
				flop          : dataRow.flop,
				burn          : dataRow.burn,
				autonextround : dataRow.autonextround,
				shoe          : dataRow.shoe
			});
		},

		async getcardtype (dealerSocket, data, next) {
			try {
				next(await services.getCardType(data.data));
			} catch (error) {
				next({ error : true, message : error });
			}
		},

		changedealer (dealerSocket, data, next) {
			if (!dealerSocket.tableId) {
				next({ error : true, message : 'table not initialised: refresh the app' });
				return;
			}

			services.changeDealer(
				data.data,
				dealerSocket.roundNum,
				dealerSocket.roundId,
				dealerSocket.realName,
				dealerSocket.tableId,
				dealerSocket.gameName,
				dealerSocket.status,
				resultData => {
					if (!resultData) {
						errorHandler(dealerSocket, 'server error on: ' + data.event);
						next({ error : true, message : 'server error: refresh the app' });
						return;
					}
					if (resultData.error) {
						errorHandler(dealerSocket, resultData.message + ' - ' + data.event);
						next(resultData);
						return;
					}

					const stored = this.dealerStorage[dealerSocket.tableId] || (this.dealerStorage[dealerSocket.tableId] = {});
					dealerSocket.dealerId   = parseInt(resultData.dealerId);
					dealerSocket.name       = resultData.dealerName;
					dealerSocket.dealerName = resultData.dealerName;
					stored.dealerId    = dealerSocket.dealerId;
					stored.name        = dealerSocket.name;
					stored.dealerImage = resultData.dealerImage;
					this.publish(resultData);
					next(resultData);
				}
			);
		},

		bettimer (dealerSocket, data, next) {
			this.publish({
				eventName   : 'setbettingtime',
				gameName    : dealerSocket.gameName,
				roundId     : parseInt(dealerSocket.roundId),
				roundNum    : parseInt(dealerSocket.roundNum),
				type        : data.countType,
				tableId     : parseInt(dealerSocket.tableId),
				bettingTime : data.data,
				totalTime   : parseInt(data.totalTime)
			});
			next();
		},

		async gettables (dealerSocket, data, next) {
			next(await services.fnGetTables(dealerSocket.gameName));
		},

		async setroundprogress (dealerSocket, data, next) {
			const roundStatus = await services.fnGetRoundStatus(dealerSocket.roundNum, dealerSocket.tableId);
			if (roundStatus !== 'S') {
				next('Error: set round status');
				return;
			}

			await services.fnSetRoundStatus(dealerSocket.roundNum, 'P', dealerSocket.tableId);
			dealerSocket.postStatus = 'P';
			dealerSocket.status     = 'P';
			this.publish({
				eventName : 'setroundprogress',
				gameName  : dealerSocket.gameName,
				roundId   : parseInt(dealerSocket.roundId),
				roundNum  : parseInt(dealerSocket.roundNum),
				tableId   : parseInt(dealerSocket.tableId),
				status    : 'P'
			});
			next(dealerSocket.status);
		},

		async timerReset (dealerSocket, data, next) {
			try {
				await services.fnResetTimer(dealerSocket.roundNum, dealerSocket.tableId);
				dealerSocket.postStatus = 'S';
				next(dealerSocket.postStatus);
			} catch (e) {
				errorHandler(dealerSocket, 'Error: timerReset');
				next(e);
			}
		},

		async setroundhold (dealerSocket, data, next) {
			const hold = data.hold ? 'H' : dealerSocket.postStatus;
			await services.fnSetRoundStatus(dealerSocket.roundNum, hold, dealerSocket.tableId);
			this.publish({
				gameName  : dealerSocket.gameName,
				eventName : 'setroundhold',
				dealerId  : parseInt(dealerSocket.dealerId),
				tableId   : parseInt(dealerSocket.tableId),
				roundId   : parseInt(dealerSocket.roundId),
				roundNum  : parseInt(dealerSocket.roundNum),
				status    : hold
			});
			next(!data.hold);
		},

		inputitem (dealerSocket, data, next) {
			if (dealerSocket.status != 'P') {
				next({ error : true, message : 'round not in progress' });
				return;
			}

			services.fnProcessCard(data.data, data.from, dealerSocket.roundNum, dealerSocket.tableId, resultData => {
				if (!resultData || resultData.error) {
					errorHandler(dealerSocket, 'Error: pocessing card - inputitem');
					next(resultData ? { error : true, message : 'scan errors' } : { error : true, message : 'server error' });
					return;
				}

				if (dealerSocket.gameInfo[data.from] instanceof Array) {
					dealerSocket.gameInfo[data.from].push(data.data);
				} else {
					dealerSocket.gameInfo[data.from] = data.data;
				}

				this.publish({
					gameName  : dealerSocket.gameName,
					roundId   : parseInt(dealerSocket.roundId),
					eventName : 'inputitem',
					tableId   : parseInt(dealerSocket.tableId),
					roundNum  : parseInt(dealerSocket.roundNum),
					gameInfo  : dealerSocket.gameInfo
				});

				services.fnGetCurrentRoundDatas(dealerSocket.tableId)
					.then(dataRow => {
						applyRound(dealerSocket, dataRow);
						next(roundAck(dataRow));
					}).catch(err => {
						errorHandler(dealerSocket, 'Error: pocessing card - inputitem');
						next({ error : true, message : err });
					});
			});
		},

		passResult (dealerSocket, data, next) {
			if (dealerSocket.resultHolder) {
				this.publish(dealerSocket.resultHolder);
				// last rounds countdown, once the players have the result
				(dealerSocket.afterResultEvents || []).forEach(e => this.publish(e));
				dealerSocket.afterResultEvents = [];
				next(true);
			} else {
				next(false);
			}
		},

		async getpartialresults (dealerSocket, data, next) {
			try {
				next(await services.fnGetPartialResults(dealerSocket.roundId, dealerSocket.roundNum, dealerSocket.tableId));
			} catch (e) {
				errorHandler(dealerSocket, 'Error: processBets - partialresults');
				next({ error : true, message : 'server error' });
			}
		},

		async displayresults (dealerSocket, data, next) {
			let result;
			try {
				result = await services.fnGetResults(dealerSocket.roundId, dealerSocket.roundNum, dealerSocket.tableId, dealerSocket.shoeId);
			} catch (e) {
				errorHandler(dealerSocket, (typeof e === 'object') ? 'Error - displayresults2' : 'Error - displayresults3');
				next((typeof e === 'object') ? e : { error : true, message : e });
				return;
			}

			const rawBets = result.rawBets;
			delete result.rawBets;

			try {
				const bonusCard = deck('0000');
				// 'bonus' is 'pocket' during the bonusplus channel (badbeat removed from pocket -12/5/17)
				const b = await bonusCard.getBonus(result.playerBonusHand, { type : 'b', badbeat : false });
				const r = await bonusCard.getBonus(result.playerBonusHand, { type : 'r' });
				const bonusAmount  = r.length ? r[0] : 0;
				const pocketAmount = b.length ? b[0] : 0;

				const flag = await services.processBets(
					dealerSocket.roundNum,
					dealerSocket.tableId,
					result.winSide,
					rawBets,
					bonusAmount,
					pocketAmount,
					result.playerCardRank,
					result.bonusplusAmount,
					{
						created_at : result.created_at,
						updated_at : result.updated_at,
						tableId    : parseInt(result.tableId),
						roundId    : parseInt(result.roundId),
						roundNum   : parseInt(result.roundNum),
						gameInfo   : result.gameInfo,
						gameResult : result.gameResult
					},
					dealerSocket.name,
					{ roundId : result.roundId, finalResult : result.finalResult, mark : result.mark }
				);

				// set bonus to passed data
				result.gameResult.pocketAmount    = pocketAmount;
				result.gameResult.bonusAmount     = bonusAmount;
				result.gameResult.bonusplusAmount = result.bonusplusAmount;

				dealerSocket.status       = 'E';
				dealerSocket.postStatus   = 'E';
				dealerSocket.resultHolder = JSON.stringify({
					gameName       : dealerSocket.gameName,
					eventName      : 'displayresults',
					tableId        : parseInt(dealerSocket.tableId),
					dealerId       : parseInt(dealerSocket.dealerId),
					roundId        : parseInt(dealerSocket.roundId),
					roundNum       : parseInt(dealerSocket.roundNum),
					gameInfo       : result.gameInfo,
					gameResult     : result.gameResult,
					regionalResult : result,
					mark           : result.mark,
					status         : 'E',
					totalWinning   : parseInt(flag.roundWins),
					userInfo       : flag.userInfo,
					meta           : result.meta
				});
				dealerSocket.afterResultEvents = await tableControl.afterResult(models, {
					gameName : dealerSocket.gameName,
					tableId  : dealerSocket.tableId,
					roundId  : dealerSocket.roundId,
					roundNum : dealerSocket.roundNum,
					dealerId : dealerSocket.dealerId
				}).catch(e => {
					console.log('last rounds failed:'.error, e);
					return [];
				});
				next(result);
			} catch (e) {
				console.log('displayresults failed:'.error, e);
				errorHandler(dealerSocket, 'Error: processBets - displayresults1');
				next({ error : true, message : 'server error' });
			}
		},

		async newround (dealerSocket, data, next) {
			let round, lastrounds;
			try {
				({ lastrounds } = await tableControl.beforeNewRound(models, dealerSocket.tableId));
				round = await services.fnProcessNewRound(dealerSocket.tableId, dealerSocket.dealerId, data.roundNum);
			} catch (err) {
				if (err instanceof tableControl.TableControlError) {
					next({ error : true, message : err.message });
					return;
				}
				console.log('newround failed:'.error, err);
				errorHandler(dealerSocket, 'Error - newround');
				next({ error : true, message : errorMessage(err) });
				return;
			}

			dealerSocket.gameInfo     = freshGameInfo();
			dealerSocket.postStatus   = 'S';
			dealerSocket.status       = 'S';
			dealerSocket.roundId      = round.id;
			dealerSocket.roundNum     = round.round_num;
			dealerSocket.latest       = [];
			dealerSocket.resultHolder = null;

			this.publish({
				gameName  : dealerSocket.gameName,
				eventName : 'newround',
				tableId   : parseInt(dealerSocket.tableId),
				roundId   : parseInt(dealerSocket.roundId),
				roundNum  : parseInt(dealerSocket.roundNum),
				bettimer  : parseInt(dealerSocket.bettimer),
				status    : 'S',
				dealerId  : dealerSocket.dealerId,
				lastround : lastrounds
			});
			next(round.round_num);
		},

		async removeitem (dealerSocket, data, next) {
			try {
				await services.fnProcessDeleteCard(data.who, dealerSocket.tableId, dealerSocket.roundNum);
			} catch (err) {
				errorHandler(dealerSocket, 'Error - removeitem');
				next({ error : true, message : err });
				return;
			}

			let shouldError = false;
			const hand = dealerSocket.gameInfo[data.who];
			if (hand instanceof Array) {
				if ((data.who == 'player' || data.who == 'dealer') && hand.length > 2) {
					dealerSocket.gameInfo[data.who] = [];
					shouldError = true;
				} else if (data.who == 'flop' && hand.length > 3) {
					dealerSocket.gameInfo[data.who] = [];
					shouldError = true;
				} else {
					hand.pop();
				}
			} else {
				dealerSocket.gameInfo[data.who] = null;
			}

			this.publish({
				gameName  : dealerSocket.gameName,
				eventName : 'removeitem',
				roundId   : parseInt(dealerSocket.roundId),
				roundNum  : parseInt(dealerSocket.roundNum),
				tableId   : parseInt(dealerSocket.tableId),
				gameInfo  : dealerSocket.gameInfo
			});

			try {
				const dataRow = await services.fnGetCurrentRoundDatas(dealerSocket.tableId);
				applyRound(dealerSocket, dataRow);
				dealerSocket.gameInfo     = dataRow.gameInfo;
				dealerSocket.resultHolder = null;
				next(shouldError ? { error : true, message : 'server error: refresh the app' } : roundAck(dataRow));
			} catch (err) {
				errorHandler(dealerSocket, 'Error - removeitem');
				next({ error : true, message : err });
			}
		},

		async autonextround (dealerSocket, data, next) {
			next(await services.fnProcessAutoNextRound(dealerSocket.tableId));
		},

		stoptimer (dealerSocket, data, next) {
			this.publish({
				gameName  : dealerSocket.gameName,
				eventName : 'stoptimer',
				roundId   : parseInt(dealerSocket.roundId),
				roundNum  : parseInt(dealerSocket.roundNum),
				dealerId  : parseInt(dealerSocket.dealerId),
				tableId   : parseInt(dealerSocket.tableId)
			});
			next();
		}
	}
};
