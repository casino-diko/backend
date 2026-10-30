'use strict';
/*
 |--------------------------------------------------------------------------
 | GameController v1.0
 |--------------------------------------------------------------------------
 | Author : Shinji Escorido
 | relay dealer's actions to both dealer socket and socket-server netsockets
 |
 */

const _              = require('lodash');
const betsCalculator = require('./betsCalculator');
const services       = require('./services');
const models         = require('./db.js');
const publisher      = require('../../core/publisher');
const logger         = require('../../core/logger');
const errorHandler   = require('../../core/errorHandler')(models);

const errorText = e => (e instanceof Error) ? e.message : JSON.stringify(e);

module.exports = {
	markJson      : {},
	// dealer shown on each table: tableId -> { dealerId, name, dealerImage }
	dealerStorage : {},

	publish (data) {
		console.log(` [${data.gameName}] publish ${data.eventName} `.info, JSON.stringify(data));
		publisher.publish(data);
	},

	fnFetchMarks () {
		services.fnFetchMarks().then(markJson => {
			this.markJson = markJson;
		}).catch(e => console.log(errorText(e).error));
	},

	fnCheckTableSlave (dataRow) {
		let slaver = [];
		if (Array.isArray(dataRow.type)) {
			_.each(dataRow.type, type => {
				if (type == 'normal' || type == 'flippy')
					dataRow.type = type;
				if (type == 'supersix' || type == 'bonus') {
					slaver.push(type);
				}
			});
		}

		return Object.assign(dataRow, { 'slave' : slaver });
	},

	fnDealerListener (dealerSocket) {
		dealerSocket.on('push', (data, next) => {
			next = (typeof next == 'function') ? next : (() => {});
			if (!data || typeof data != 'object') {
				next(false);
				return;
			}

			switch (data.event) {
				case 'checkifdealer':
					services.fnCardType(data.data).then(next);
					break;

				case 'init':
					services.fnGetCurrentRoundDatas(data.data)
					.then(dr => {
						let dataRow = Object.assign({}, this.fnCheckTableSlave(dr));
						if (!dataRow.dealer) {
							throw 'Error: init data - round has no dealer';
						}

						if (!this.dealerStorage[data.data])
							this.dealerStorage[data.data] = {
								dealerId    : +dataRow.dealer.id,
								name        : dataRow.dealer.name,
								dealerImage : dataRow.dealer.dealer_image
							};

						dataRow.dealer.dealer_image = this.dealerStorage[data.data].dealerImage;
						dealerSocket.type        = dataRow.type;
						dealerSocket.slave       = dataRow.slave;
						dealerSocket.roundId     = parseInt(dataRow.roundId);
						dealerSocket.roundNum    = parseInt(dataRow.roundNum);
						dealerSocket.status      = dataRow.status;
						dealerSocket.postStatus  = dataRow.postStatus;
						dealerSocket.tableId     = data.data;
						dealerSocket.dealerId    = dataRow.dealer.id = this.dealerStorage[data.data].dealerId;
						dealerSocket.name        = dataRow.dealer.name = this.dealerStorage[data.data].name;
						dealerSocket.realName    = dealerSocket.name;
						dealerSocket.bettimer    = parseInt(dataRow.bettimer);
						dealerSocket.shoeId      = dataRow.shoeId;
						dealerSocket.betSettings = data.betSettings;
						dealerSocket.gameInfo    = dataRow.gameInfo;

						if (!dealerSocket.latest.length) {
							dealerSocket.latest = _.filter(
								['player1', 'player2', 'player3', 'banker1', 'banker2', 'banker3'],
								key => dataRow.gameInfo[key]
							);
						}

						logger.show('CONNECT', dealerSocket).catch(() => console.log('--socket connected'));
						next(dataRow);
					}).catch(err => {
						console.log(errorText(err).error);
						next(false);
					});
					break;

				case 'gettables' :
					services.fnGetTables(dealerSocket.gameName)
					.then(next)
					.catch(e => {
						console.log(errorText(e).error);
						next(false);
					});
					break;

				case 'setroundprogress' :
					services.fnSetRoundStatus(dealerSocket.tableId, dealerSocket.roundNum, 'P')
						.then(() => {
							dealerSocket.postStatus = dealerSocket.status = 'P';
							next(dealerSocket.postStatus);

							this.publish({
								eventName : 'setroundprogress',
								gameName  : dealerSocket.gameName,
								tableId   : parseInt(dealerSocket.tableId),
								roundId   : parseInt(dealerSocket.roundId),
								roundNum  : parseInt(dealerSocket.roundNum),
								status    : 'P'
							});
						}).catch(() => {
							errorHandler(dealerSocket, 'Error: setroundprogress');
							next('roundStatusError');
						});
					break;

				case 'timerReset' :
					services.fnResetTimer(dealerSocket.tableId, dealerSocket.roundNum)
						.then(() => {
							dealerSocket.postStatus = 'S';
							next(dealerSocket.postStatus);
						}).catch(e => {
							errorHandler(dealerSocket, 'Error: timerReset');
							next(e);
						});
					break;

				case 'inputitem' :
					this.fnInputItem(dealerSocket, data.data || {}, next);
					break;

				case 'displayresults':
					services.fnGetResults(dealerSocket.tableId, dealerSocket.roundNum)
						.then(d => {
							// process bets calculation and send winnings to users
							return betsCalculator.processBets(
								dealerSocket.tableId,
								dealerSocket.roundId,
								d,
								dealerSocket.gameName,
								dealerSocket.realName,
								dealerSocket.roundNum
							).then(roundMarkMoneyData => {
								dealerSocket.postStatus = dealerSocket.status = 'E';
								let gResultPub = ['winner', 'pairs'];
								d.bonus.oddsbonus = (roundMarkMoneyData.oddsbonus) ? roundMarkMoneyData.oddsbonus - 1 : null;
								if (dealerSocket.slave.indexOf('supersix') > -1) {
									gResultPub.push('supersix');
								}
								if (dealerSocket.slave.indexOf('bonus') > -1) {
									gResultPub.push('bonus');
									gResultPub.push('size');
								}
								let regionalResult = Object.assign(d, { game_info : dealerSocket.gameInfo });
								this.publish({
									eventName      : 'displayresults',
									gameName       : dealerSocket.gameName,
									tableId        : parseInt(dealerSocket.tableId),
									roundId        : parseInt(dealerSocket.roundId),
									roundNum       : parseInt(dealerSocket.roundNum),
									status         : 'E',
									gameInfo       : { player : d.player, banker : d.banker },
									gameResult     : _.pick(d, gResultPub),
									regionalResult,
									dealerName     : dealerSocket.realName,
									mark           : roundMarkMoneyData.gameMarksData.gameMarks,
									totalWinning   : parseInt(roundMarkMoneyData.roundWins),
									userInfo       : roundMarkMoneyData.userInfo
								});
								next(d);
							}).catch(e => {
								console.log(`process bets: ${errorText(e)}`.error);
								errorHandler(dealerSocket, 'Error: process bets');
								next(d);
							});
						}).catch(e => {
							console.log(`displayresults: ${errorText(e)}`.error);
							errorHandler(dealerSocket, 'Error: fnGetResults');
							next(false);
						});
					break;

				case 'newround' :
					services.fnProcessNewRound(
						(data.data || {}).roundNum,
						dealerSocket.tableId,
						dealerSocket.dealerId,
						dealerSocket.shoeId
					).then(round => {
						dealerSocket.postStatus = dealerSocket.status = 'S';
						dealerSocket.roundId    = round.id;
						dealerSocket.roundNum   = round.round_num;
						dealerSocket.latest     = [];
						dealerSocket.gameInfo   = {};

						this.publish({
							gameName  : dealerSocket.gameName,
							eventName : 'newround',
							dealerId  : dealerSocket.dealerId,
							tableId   : parseInt(dealerSocket.tableId),
							roundId   : parseInt(dealerSocket.roundId),
							roundNum  : parseInt(dealerSocket.roundNum),
							bettimer  : parseInt(dealerSocket.bettimer),
							status    : dealerSocket.status
						});
						next(round);
					}).catch(e => {
						errorHandler(dealerSocket, 'Error : fnProcessNewRound');
						console.log(errorText(e).error);
						next(false);
					});
					break;

				case 'removeitem' :
					services.fnProcessDeleteCard(dealerSocket.roundNum, dealerSocket.tableId)
					.then(() => services.fnGetCurrentRoundDatas(dealerSocket.tableId))
					.then(dr => {
						let dataRow = Object.assign({}, this.fnCheckTableSlave(dr));
						dealerSocket.gameInfo = dataRow.gameInfo;
						this.publish({
							gameName  : dealerSocket.gameName,
							eventName : 'removeitem',
							roundId   : parseInt(dealerSocket.roundId),
							roundNum  : parseInt(dealerSocket.roundNum),
							dealerId  : parseInt(dealerSocket.dealerId),
							tableId   : parseInt(dealerSocket.tableId),
							gameInfo  : dealerSocket.gameInfo
						});
						next(dataRow);
					}).catch(() => {
						console.log('Error: remove item'.error);
						errorHandler(dealerSocket, 'Error: remove item');
						next(false);
					});
					break;

				case 'autonextround':
					services.fnProcessAutoNextRound(dealerSocket.tableId)
						.then(next)
						.catch(() => {
							errorHandler(dealerSocket, 'Error: autonextround');
							next(false);
						});
					break;

				case 'stoptimer' :
					this.publish({
						gameName  : dealerSocket.gameName,
						eventName : 'stoptimer',
						roundId   : parseInt(dealerSocket.roundId),
						dealerId  : parseInt(dealerSocket.dealerId),
						tableId   : parseInt(dealerSocket.tableId)
					});
					next(true);
					break;

				case 'flip':
					this.publish({
						eventName : 'flip',
						gameName  : dealerSocket.gameName,
						roundId   : parseInt(dealerSocket.roundId),
						dealerId  : parseInt(dealerSocket.dealerId),
						tableId   : parseInt(dealerSocket.tableId),
						gameInfo  : dealerSocket.gameInfo
					});
					next(true);
					break;

				case 'flippytimer':
					this.publish({
						eventName : 'flippytimer',
						gameName  : dealerSocket.gameName,
						roundId   : parseInt(dealerSocket.roundId),
						dealerId  : parseInt(dealerSocket.dealerId),
						tableId   : parseInt(dealerSocket.tableId),
						flipTime  : parseInt((data.data || {}).betTime),
						totalTime : parseInt((data.data || {}).totalTime)
					});
					next(true);
					break;

				case 'setbettingtime' :
					this.publish({
						eventName   : 'setbettingtime',
						gameName    : dealerSocket.gameName,
						roundId     : parseInt(dealerSocket.roundId),
						dealerId    : parseInt(dealerSocket.dealerId),
						tableId     : parseInt(dealerSocket.tableId),
						bettingTime : parseInt((data.data || {}).betTime),
						totalTime   : parseInt((data.data || {}).totalTime)
					});
					next(true);
					break;
			} //==end switch
		}); //== end push event
	},

	/**
	 * inputitem: a scanned card (player1..banker3), dealer code (dealer_id),
	 * new shoe (shoe) or burn card (shoeburncard).
	 */
	fnInputItem (dealerSocket, item, next) {
		services.fnProcessCard(
			item.value,
			item.from,
			dealerSocket.roundNum,
			dealerSocket.roundId,
			dealerSocket.tableId,
			dealerSocket.gameName,
			dealerSocket.status
		).then(resultData => {
			if (item.from == 'shoeburncard') {
				next(item.value);

				this.publish({
					eventName : 'shoeburncard',
					gameName  : dealerSocket.gameName,
					tableId   : parseInt(dealerSocket.tableId),
					roundId   : parseInt(dealerSocket.roundId),
					dealerId  : parseInt(dealerSocket.dealerId),
					value     : item.value
				});
				return;
			}
			if (resultData == 'roundStatusError') {
				next(resultData);
				return;
			}
			if (!resultData) {
				errorHandler(dealerSocket, 'Error: inputitem');
				next(false);
				return;
			}
			if (item.from == 'shoe') {
				dealerSocket.shoeId = resultData;
				next('shoe changed');

				this.publish({
					tableId   : parseInt(dealerSocket.tableId),
					gameName  : dealerSocket.gameName,
					roundId   : parseInt(dealerSocket.roundId),
					dealerId  : parseInt(dealerSocket.dealerId),
					gameInfo  : {},
					eventName : 'shoechange'
				});
				return;
			}

			let isDealerChange = (resultData.eventName == 'dealerchange');

			if (isDealerChange) {
				let stored = this.dealerStorage[dealerSocket.tableId] = this.dealerStorage[dealerSocket.tableId] || {};
				dealerSocket.dealerId = parseInt(resultData.dealerId);
				dealerSocket.realName = resultData.dealerName;
				stored.dealerId       = dealerSocket.dealerId;
				stored.name           = resultData.dealerName;
				stored.dealerImage    = resultData.dealerImage;
				next(resultData);
			}

			return services.fnGetCurrentRoundDatas(dealerSocket.tableId).then(dr => {
				let dataRow = Object.assign({}, this.fnCheckTableSlave(dr));

				if (resultData.eventName == 'inputitem') {
					dealerSocket.latest.push(item.from);
					dealerSocket.gameInfo = dealerSocket.gameInfo || {};
					dealerSocket.gameInfo[item.from] = item.value;
					resultData.gameInfo = dealerSocket.gameInfo;
				}

				this.publish(resultData);
				// dealerchange was already acknowledged above
				if (!isDealerChange) next(dataRow);
			}).catch(() => {
				errorHandler(dealerSocket, 'Error: init - fnGetCurrentRoundDatas');
				if (!isDealerChange) next(false);
			});
		}).catch(e => {
			console.log(`inputitem: ${errorText(e)}`.error);
			errorHandler(dealerSocket, 'Error: inputitem');
			next(false);
		});
	}
}; // end module exports
