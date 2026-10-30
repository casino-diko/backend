'use strict';

	/*
	|--------------------------------------------------------------------------
	| GameController v2.0
	|--------------------------------------------------------------------------
	| Author : Shinji Escorido
	| relay dealer's actions to both dealer socket and socket-server (redis)
	|
	*/

const _              = require('lodash');
const betsCalculator = require('./betsCalculator');
const services       = require('./services');
const models         = require('./db');
const publisher      = require('../../core/publisher');
const logger         = require('../../core/logger');
const errorHandler   = require('../../core/errorHandler')(models);

module.exports = {
	markJson      : {},
	// per table dealer, survives dealer page reconnects
	dealerStorage : {},

	sendToSocketServer (data) {
		if (data.eventName !== 'setbettingtime') {
			console.log(' ============== publish data ================ ');
			console.log(data);
		}
		publisher.publish(data);
	},

	fnFetchMarks () {
		return services.fnFetchMarks()
			.then(markJson => {
				this.markJson = markJson;
			})
			.catch(e => console.log('could not fetch info marks'.error, e));
	},

	// rebuilds the order the dragon / tiger cards were dealt in (used by removeitem)
	fnRestoreLatest (dealerSocket, dataRow) {
		if (dealerSocket.latest.length) return;

		dealerSocket.latest = [];
		if (dataRow.dragon) {
			dealerSocket.latest.push('dragon');
		}
		if (dataRow.tiger) {
			dealerSocket.latest.push('tiger');
		}
	},

	fnDealerListener (dealerSocket) {
		dealerSocket.on('push', (data, callback) => {
			// not every dealer page asks for an ack
			const next = (typeof callback === 'function') ? callback : _.noop;

			if (!data || typeof data !== 'object') return;

			switch (data.event) {

				case 'checkifdealer' :
					services.fnCardType(data.data).then(res => next(res));
				break;

				case 'init' :
					services.fnGetCurrentRoundDatas(data.data)
					.then(dataRow => {
						if (!this.dealerStorage[data.data]) {
							if (!dataRow.dealer) {
								throw new Error(`round ${dataRow.roundId} has no dealer`);
							}

							this.dealerStorage[data.data] = {
								dealerId    : dataRow.dealer.id,
								realName    : dataRow.dealer.real_name,
								name        : dataRow.dealer.name,
								dealerImage : dataRow.dealer.dealer_image
							};
						}

						this.fnRestoreLatest(dealerSocket, dataRow);

						const dealer = this.dealerStorage[data.data];

						dataRow.dealer = dataRow.dealer || {};
						dataRow.dealer.dealer_image = dealer.dealerImage;
						dealerSocket.roundId    = parseInt(dataRow.roundId);
						dealerSocket.roundNum   = parseInt(dataRow.roundNum);
						dealerSocket.status     = dataRow.status;
						dealerSocket.postStatus = dataRow.postStatus;
						dealerSocket.tableId    = data.data;
						dealerSocket.dealerId   = dataRow.dealer.id = dealer.dealerId;
						dealerSocket.realName   = dataRow.dealer.real_name = dealer.realName;
						dealerSocket.name       = dataRow.dealer.name = dealer.name;
						dealerSocket.bettimer   = parseInt(dataRow.bettimer);
						dealerSocket.shoeId     = dataRow.shoeId;
						dealerSocket.gameInfo   = dataRow.gameInfo;

						logger.show('CONNECT', dealerSocket).catch(() => console.log('--socket connected'));
						next(dataRow);
					}).catch(e => {
						console.log('init failed'.error, e);
						errorHandler(dealerSocket, 'Error:init');
						next(false);
					});
				break;

				// betting countdown tick from the dealer page
				case 'bettimer' :
					this.sendToSocketServer({
						eventName   : 'setbettingtime',
						gameName    : dealerSocket.gameName,
						roundId     : parseInt(dealerSocket.roundId),
						roundNum    : parseInt(dealerSocket.roundNum),
						tableId     : parseInt(dealerSocket.tableId),
						bettingTime : parseInt(data.data),
						totalTime   : parseInt(data.totalTime)
					});
				break;

				case 'gettables' :
					services.fnGetTables(dealerSocket.gameName)
					.then(tables => next(tables))
					.catch(e => {
						errorHandler(dealerSocket, 'Error:gettables');
						next(false);
					});
				break;

				case 'setroundprogress' :
					// S -> P, only when the round is still in betting
					services.fnSetRoundStatus(dealerSocket.roundId, 'P', dealerSocket.tableId, dealerSocket.roundNum, 'S')
					.then(changed => {
						if (!changed) {
							next('roundStatusError');
							return;
						}

						dealerSocket.postStatus = 'P';
						dealerSocket.status     = 'P';
						next(dealerSocket.postStatus);

						this.sendToSocketServer({
							eventName : 'setroundprogress',
							gameName  : dealerSocket.gameName,
							roundId   : parseInt(dealerSocket.roundId),
							roundNum  : parseInt(dealerSocket.roundNum),
							tableId   : parseInt(dealerSocket.tableId),
							status    : 'P'
						});
					}).catch(e => {
						errorHandler(dealerSocket, 'Error:setroundprogress');
						next('roundStatusError');
					});
				break;

				case 'timerReset' :
					services.fnResetTimer(dealerSocket.roundId, dealerSocket.tableId, dealerSocket.roundNum)
					.then(() => {
						dealerSocket.postStatus = 'S';
						next(dealerSocket.postStatus);
					}).catch(e => {
						errorHandler(dealerSocket, 'Error: timerReset');
						next(e);
					});
				break;

				case 'setroundhold' : {
					const hold = (data.hold) ? 'H' : dealerSocket.postStatus;

					services.fnSetRoundStatus(dealerSocket.roundId, hold, dealerSocket.tableId, dealerSocket.roundNum)
					.then(() => {
						this.sendToSocketServer({
							gameName  : dealerSocket.gameName,
							eventName : 'setroundhold',
							tableId   : parseInt(dealerSocket.tableId),
							roundId   : parseInt(dealerSocket.roundId),
							roundNum  : parseInt(dealerSocket.roundNum),
							status    : hold
						});
						next(!data.hold);
					}).catch(e => {
						errorHandler(dealerSocket, 'Error:setroundhold');
					});
				break;
				}

				case 'inputitem' :
					services.fnProcessCard(
						data.value,
						data.from,
						dealerSocket.roundNum,
						dealerSocket.roundId,
						dealerSocket.realName,
						dealerSocket.tableId,
						dealerSocket.gameName,
						dealerSocket.status
					).then(resultData => {
						if (!resultData) {
							errorHandler(dealerSocket, 'Error: pocessing card - inputitem');
							next(false);
							return;
						}

						if (resultData == 'roundStatusError') {
							next(resultData);
							return;
						}

						if (data.from == 'shoe') {
							dealerSocket.shoeId = resultData;
							next('shoe changed');

							this.sendToSocketServer({
								tableId   : parseInt(dealerSocket.tableId),
								gameName  : dealerSocket.gameName,
								roundId   : parseInt(dealerSocket.roundId),
								roundNum  : parseInt(dealerSocket.roundNum),
								dealerId  : parseInt(dealerSocket.dealerId),
								gameInfo  : {},
								eventName : 'shoechange'
							});
							return;
						}

						if (resultData.eventName == 'dealerchange') {
							const dealer = this.dealerStorage[dealerSocket.tableId] = this.dealerStorage[dealerSocket.tableId] || {};

							dealerSocket.dealerId = dealer.dealerId = parseInt(resultData.dealerId);
							dealerSocket.realName = dealer.realName = resultData.dealerName;
							dealerSocket.name     = dealer.name     = resultData.dealerName;
							dealer.dealerImage    = resultData.dealerImage;

							// record dealer change
							this.sendToSocketServer(resultData);
							next(resultData);
							return;
						}

						// game card (burn / dragon / tiger)
						dealerSocket.gameInfo[resultData.type] = resultData.value;
						resultData.gameInfo = dealerSocket.gameInfo;

						if (data.from == 'dragon' || data.from == 'tiger') {
							dealerSocket.latest.push(data.from);

							this.sendToSocketServer(resultData);
							next({
								from  : resultData.type,
								value : resultData.value
							});
							return;
						}

						// burn card: ack with the refreshed round data
						return services.fnGetCurrentRoundDatas(dealerSocket.tableId)
						.then(dataRow => {
							this.fnRestoreLatest(dealerSocket, dataRow);
							this.sendToSocketServer(resultData);
							next(dataRow);
						});
					}).catch(e => {
						console.log('inputitem failed'.error, e);
						errorHandler(dealerSocket, 'Error: pocessing card - inputitem');
						next(false);
					});
				break;

				case 'showresults' :
					next(true);
				break;

				case 'displayresults' :
					services.fnGetResults(dealerSocket.roundId, dealerSocket.tableId, dealerSocket.roundNum)
					.then(data => {
						// process bets calculation and send winnings to users
						return betsCalculator.processBets(
							data.gameResult.game_result,
							data.result,
							this.markJson,
							dealerSocket.tableId,
							dealerSocket.shoeId,
							dealerSocket.name,
							data.roundStatus
						).then(roundMarkMoneyData => {
							dealerSocket.postStatus = 'E';
							dealerSocket.status     = 'E';

							this.sendToSocketServer({
								gameName       : dealerSocket.gameName,
								eventName      : 'displayresults',
								tableId        : parseInt(dealerSocket.tableId),
								dealerId       : parseInt(dealerSocket.dealerId),
								roundId        : parseInt(dealerSocket.roundId),
								roundNum       : parseInt(dealerSocket.roundNum),
								gameInfo       : data.gameInfo,
								gameResult     : data.gameResult.game_result,
								mark           : roundMarkMoneyData.gameMarksData,
								totalWinning   : parseInt(roundMarkMoneyData.roundWins),
								status         : 'E',
								userInfo       : roundMarkMoneyData.userInfo,
								regionalResult : data.result,
								dealerName     : dealerSocket.name
							});
							next(data.result);
						}, e => {
							console.log('err: ', e);
							errorHandler(dealerSocket, 'Error:displayresults');
							next({ error : true, message : 'server error' });
						});
					}, e => {
						console.log('err: ', e);
						errorHandler(dealerSocket, 'Error:displayresults');
						next((e && typeof e === 'object') ? e : { error : true, message : 'server error' });
					}).catch(e => console.log('displayresults failed'.error, e));
				break;

				case 'newround' :
					services.fnProcessNewRound(
						dealerSocket.tableId,
						dealerSocket.dealerId,
						dealerSocket.realName,
						dealerSocket.shoeId,
						data.roundNum
					)
					.then(round => {
						dealerSocket.postStatus = 'S';
						dealerSocket.status     = 'S';
						dealerSocket.roundId    = round.id;
						dealerSocket.roundNum   = round.round_num;
						dealerSocket.latest     = [];
						dealerSocket.gameInfo   = { burn : null, tiger : null, dragon : null };

						this.sendToSocketServer({
							gameName  : dealerSocket.gameName,
							eventName : 'newround',
							tableId   : parseInt(dealerSocket.tableId),
							dealerId  : dealerSocket.dealerId,
							roundId   : parseInt(dealerSocket.roundId),
							roundNum  : parseInt(dealerSocket.roundNum),
							bettimer  : parseInt(dealerSocket.bettimer),
							status    : 'S'
						});
						next(round.round_num);
					}).catch(e => {
						console.log('newround failed'.error, e);
						errorHandler(dealerSocket, 'Error:newround');
						next(false);
					});
				break;

				case 'removeitem' : {
					const deleteData = {
						tableId  : dealerSocket.tableId,
						roundNum : dealerSocket.roundNum,
						roundId  : dealerSocket.roundId,
						realName : dealerSocket.realName
					};

					// last dealt dragon / tiger card, the burn card otherwise
					const tod = (dealerSocket.latest.length) ? dealerSocket.latest[dealerSocket.latest.length - 1] : null;

					services.fnProcessDeleteCard(deleteData, tod, dealerSocket.tableId, dealerSocket.roundNum)
					.then(data => {
						dealerSocket.gameInfo[data.arrayDeleted] = null;

						this.sendToSocketServer({
							gameName  : dealerSocket.gameName,
							eventName : 'removeitem',
							roundId   : parseInt(dealerSocket.roundId),
							roundNum  : parseInt(dealerSocket.roundNum),
							tableId   : parseInt(dealerSocket.tableId),
							gameInfo  : dealerSocket.gameInfo
						});
						dealerSocket.latest.pop();
						next(data.arrayDeleted);
					}).catch(e => {
						errorHandler(dealerSocket, 'Error:removeitem');
						next(false);
					});
				break;
				}

				case 'autonextround' :
					services.fnProcessAutoNextRound(dealerSocket.tableId)
					.then(delay => next(delay))
					.catch(e => {
						errorHandler(dealerSocket, 'Error:autonextround');
						next(false);
					});
				break;

				case 'stoptimer' :
					this.sendToSocketServer({
						gameName  : dealerSocket.gameName,
						eventName : 'stoptimer',
						roundId   : parseInt(dealerSocket.roundId),
						roundNum  : parseInt(dealerSocket.roundNum),
						dealerId  : parseInt(dealerSocket.dealerId),
						tableId   : parseInt(dealerSocket.tableId)
					});
					next();
				break;

				// stores the table's betting time; players are told through 'bettimer'
				case 'setbettingtime' :
					services.fnProcessBetTimer({ data : data.data, totalTime : data.totalTime }, dealerSocket.tableId)
					.then(() => {
						dealerSocket.bettimer = parseInt(data.data);
						next();
					}).catch(e => {
						errorHandler(dealerSocket, 'Error:setbettingtime');
						next(false);
					});
				break;

			} //== end switch

		}); //== end push event
	}
}; // end module exports
