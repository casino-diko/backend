"use strict";

/*
|--------------------------------------------------------------------------
| BetsCalculator v1.1
|--------------------------------------------------------------------------
| Author : Shinji Escorido
| Processing of bets
|
| fnSettle() is the pure payout computation, processBets() persists it.
|
*/

const _      = require("lodash");
const moment = require("moment");
const models = require("./db.js");
const http   = require("../../core/http");
const conf   = require("../../config");

let apiUrlWarned = false;

module.exports = {
    multipliers : {
        player      : 1,
        playerpair  : 11,
        tie         : 8,
        bankerpair  : 11,
        banker      : 0.95
    },
	multipliers_supersix : {
        player      : 1,
        playerpair  : 11,
        tie         : 8,
        bankerpair  : 11,
        banker      : 1,
		supersix    : 12
	},

    /**
     * Settles a round: pushes the road map mark, flips the round P -> E,
     * stores every bet's result and credits transfer-wallet users, all in one
     * transaction. Rejects (and changes nothing) when the round was already
     * resulted, which prevents double payouts.
     */
    async processBets (tableId, roundId, result, gameName, dealer, roundNum) {
        tableId  = parseInt(tableId);
        roundNum = parseInt(roundNum);

        let winValue = result[result.winner == "tie" ? "player" : result.winner].total;
        let markData = this.fnGetCardSideBetMark(result.winner, result.pairs);

        result.resulted_at = moment().utcOffset(0).format("YYYY-MM-DD HH:mm:ss");
        result.created_at = moment(result.created_at).utcOffset(0).format("YYYY-MM-DD HH:mm:ss");

        let settled = this.fnSettle(result, result.bets);
        let gameResult = _.pick(result, ["winner", "pairs", "supersix", "bonus", "size"]);

        let gameMark = await models.withTransaction(async session => {
            // without bets the round is closed from any open status (never twice, never after a cancel)
            let round = await models.rounds.findOneAndUpdate(
                { table_id : tableId, round_num : roundNum, status : _.isEmpty(settled.data) ? { $in : ["S", "P", "H"] } : "P" },
                { $set : { status : "E", game_result : gameResult } },
                { session, new : true }
            );

            if (!round) {
                throw new Error(`round ${roundNum} of table ${tableId} is not in progress`);
            }

            if (settled.data.length) {
                await models.bets.bulkWrite(_.map(settled.data, row => ({
                    updateOne : {
                        filter : { _id : row.id },
                        update : { $set : {
                            bet_history   : row.bet_history,
                            total_winning : row.total_winning,
                            total_rolling : row.total_rolling,
                            total_lost    : row.total_lost,
                            total_win     : row.total_win
                        } }
                    }
                })), { session });
            }

            let credits = _.map(settled.moneyByUser, (money, userId) => ({
                updateOne : { filter : { _id : parseInt(userId) }, update : { $inc : { money } } }
            }));

            if (credits.length) {
                await models.users.bulkWrite(credits, { session });
            }

            // append the mark to the table's current road map (latest shoe)
            return models.gameMarks.findOneAndUpdate(
                { table_id : tableId },
                // round_id: lets a void (admin) take exactly this round's mark off the road map
                { $push : { mark : { round_id : round._id, natural : result.natural, num : winValue, mark : markData } } },
                { session, sort : { _id : -1 }, new : true, projection : { table_id : 1, mark_num : 1 } }
            ).lean();
        });

        this.sendToAPIServer(gameName, result, settled.data, dealer);

        return {
            gameMarksData : {
                id         : gameMark ? gameMark.table_id : tableId,
                shoeNumber : gameMark ? gameMark.mark_num : null,
                gameMarks  : {
                    num     : winValue,
                    mark    : markData,
                    natural : result.natural
                }
            },
            roundWins : settled.roundWins,
            roundBets : settled.roundBets,
            userInfo  : settled.userInfo,
            oddsbonus : settled.oddsbonus
        };
    },

    /**
     * Pure payout computation. `bets` rows are { id, user_id, type, bet_history,
     * user : { money, user_type, vendor : { integration_type } }, ... }; they
     * are mutated with the evaluated bet_history and totals (the same objects
     * are published in the round result).
     *
     * @returns {{ data, userInfo, roundWins, roundBets, oddsbonus, moneyByUser }}
     */
    fnSettle (result, bets) {
        let roundWins   = 0;
        let roundBets   = 0;
        let oddsbonus   = null;
        let userInfo    = [];
        let moneyByUser = {};
        let data        = bets || [];

        _.forEach(data, row => {
            let type = (row.type == "f" || row.type == "r") ? "fnEvaluate" : row.type;
            if (!["fnEvaluate", "s", "b"].includes(type)) {
                throw new Error(`unsupported bet type "${row.type}" (bet ${row.id})`);
            }
            if (!row.user || !row.user.vendor) {
                throw new Error(`user / vendor of bet ${row.id} not found`);
            }

            let temp = this[type](result, row.bet_history);

            row.bet_history     = temp.data;
            row.total_rolling   = temp.total_rolling;
            row.total_bet       = temp.total_bets;
            row.total_winning   = temp.payout;
            row.total_win       = temp.total_win;
            row.total_lost      = temp.total_lost;

            if (temp.oddsbonus !== undefined) {
                oddsbonus = temp.oddsbonus;
            }

            userInfo.push({
                id              : row.user_id,
                type            : row.type,
                total_winning   : Math.round(temp.total_win * 100) / 100,
                money           : row.user.money + temp.total_win,
				user_type       : row.user.user_type,
                total_lost      : temp.total_lost,
                bets            : row.bet_history
            });

            // seamless wallets are credited by the vendor itself
            if (row.user.vendor.integration_type == "transfer" && temp.total_win) {
                moneyByUser[row.user_id] = (moneyByUser[row.user_id] || 0) + temp.total_win;
            }

            roundWins += temp.payout;
            roundBets += temp.total_bets;
        });

        return { data, userInfo, roundWins, roundBets, oddsbonus, moneyByUser };
    },

    /**
     * Pass data for current round to Nihtan API Server.
     *
     * @param game
     * @param result
     * @param data
     * @param dealer
     */
    sendToAPIServer (game, result, data, dealer) {
        if (!conf.apiHistoryUrl) {
            if (!apiUrlWarned) {
                apiUrlWarned = true;
                console.log("API_HISTORY_URL is not set, round history is not sent".debug);
            }
            return;
        }

        let body = {
            game,
            table       : result.table,
            dealer,
            round_no    : result.round_no,
            game_info   : { player : result.player, banker : result.banker },
			game_result : _.pick(result, ["winner", "pairs", "supersix", "bonus", "size"]),
            created_at  : result.created_at,
            resulted_at : result.resulted_at,
            data        : _.map(data, (row) => {
                return {
                    id              : row.user.id,
                    user_id         : row.user.user_id,
                    user_name       : row.user.user_name,
                    vendor_id       : row.user.vendor_id,
                    type            : row.type,
					user_type       : row.user.user_type,
					bets            : row.bet_history,
					bet_range       : row.bet_range,
					total_bet       : row.total_bet,
                    total_rolling   : row.total_rolling,
                    total_win       : row.total_win,
                    total_lost      : row.total_lost,
                    bet_id          : row.bet_id,
                    session_id      : row.session_id,
                    created_at      : moment(row.created_at).utcOffset(0).format("YYYY-MM-DD HH:mm:ss"),
                    currency        : row.currency || row.user.currency || row.user.vendor.currency,
		            multiplier      : row.user.denomination || row.user.vendor.multiplier
                };
            })
        };

        http.postJson(conf.apiHistoryUrl, body).catch(e =>
            console.log(`history api: ${e.message}`.error)
        );
    },

    /**
     * Evaluate each users' bet history
     *
     * @param result
     * @param betHistory
     */
	fnEvaluate (result, betHistory) {
        // function for default baccarat`
        let processed = [];
        let total_lost = 0;
        let total_win = 0;
        let total_bets;

        let total_rolling = total_bets = _.reduce(betHistory, (sum, row) => {
            return sum + row.bet_money;
        }, 0);

        let payout = 0;

        _.forEach(betHistory, (row) => {
            let key = row.bet.replace("bet_", "");

            // payout pairs
            if (key.indexOf("pair") !== -1 && result.pairs.indexOf(key.replace("pair", "")) !== -1) {
                row.win_money = this.multipliers[key] * row.bet_money;
                payout += row.win_money;
                total_win += (row.win_money + row.bet_money)
            }

            // payout main bets
            if (key === result.winner) {
                row.win_money = this.multipliers[key] * row.bet_money;
                payout += row.win_money;
                total_win += (row.win_money + row.bet_money)
            }

            // return money if bet if result is tie
            if (result.winner == "tie" && key !== "tie" && key.indexOf("pair") == -1) {
                row.win_money = row.bet_money;
                payout += row.win_money;
                total_rolling -=  row.bet_money;
                total_win += row.bet_money
            }

            if (!row.win_money) {
                total_lost += row.bet_money;
            }

            if (row.win_money) {
                row.win_money += (result.winner == "tie" && key !== "tie" && key.indexOf("pair") == -1 ? 0 : row.bet_money);
            }

            processed.push(row);
        });

        return { data : processed, total_rolling, total_bets, payout, total_lost, total_win };
    },
	s (result, betHistory) {
        let processed = [];
        let total_lost = 0;
        let total_win = 0;
        let total_bets;

        let total_rolling = total_bets = _.reduce(betHistory, (sum, row) => {
            return sum + row.bet_money;
        }, 0);

        let payout = 0;

        _.forEach(betHistory, (row) => {
            let key = row.bet.replace("bet_", "");

            // payout pairs
            if (key.indexOf('pair') !== -1 && result.pairs.indexOf(key.replace("pair", "")) !== -1) {
                row.win_money = this.multipliers_supersix[key] * row.bet_money;
                payout += row.win_money;
                total_win += (row.win_money + row.bet_money)
            }

            // payout main bets
            if (key === result.winner) {
				if(key == 'banker' && result.supersix){
					// if user bets on banker and result is supersix
					// banker will win 0.5 only
					row.win_money = 0.5 * row.bet_money;
				} else {
					row.win_money = this.multipliers_supersix[key] * row.bet_money;
				}
				payout += row.win_money;
				total_win += (row.win_money + row.bet_money);
            }

			if (key === "supersix" && result.supersix) {
				row.win_money = this.multipliers_supersix[key] * row.bet_money;
				payout += row.win_money;
				total_win += (row.win_money + row.bet_money)
			}

			// return money if bet if result is tie
            if (result.winner == "tie" && key !== "tie" && key.indexOf("pair") == -1 && key !== "supersix") {
                row.win_money = row.bet_money;
                payout += row.win_money;
                total_rolling -=  row.bet_money;
                total_win += row.bet_money
            }

            if (!row.win_money) {
                total_lost += row.bet_money;
            }

            if (row.win_money) {
                row.win_money += (result.winner == "tie" && key !== "tie" && key.indexOf("pair") == -1  && key !== "supersix" ? 0 : row.bet_money);
            }

            processed.push(row);
        });

        return {data: processed, total_rolling, total_bets, payout, total_lost, total_win};
    },
	odds : {
		'bonus_9' : 31,
		'bonus_8' : 11,
		'bonus_7' : 7,
		'bonus_6' : 5,
		'bonus_5' : 3,
		'bonus_4' : 2,
		'bonus_3' : 0,
		'bonus_2' : 0,
		'bonus_1' : 0,
		'natural_banker'  : 2,
		'natural_player'  : 2,
		'natural_tie' : 1
	},
	bigSmallOdds : {
		'big' : 0.54,
		'small' : 1.5
	},
	bonusCounter(k,r){
		return r.bonus.type ? this.odds[r.bonus.type] :
			   this.odds[r.bonus.diff] ? this.odds[r.bonus.diff] : 0;
	},
	b (result, betHistory) {
        let processed = [];
        let total_lost = 0;
        let total_win = 0;
        let total_bets;
        let oddsbonus;
        let total_rolling = total_bets = _.reduce(betHistory, (sum, row) => {
            return sum + row.bet_money;
        }, 0);

        let payout = 0;

        _.forEach(betHistory, (row) => {
            let key = row.bet.replace("bet_", "");
            // payout pairs
            if (key.indexOf("pair") !== -1 && result.pairs.indexOf(key.replace("pair", "")) !== -1) {
                row.win_money = this.multipliers[key] * row.bet_money;

                payout += row.win_money;
                total_win += (row.win_money + row.bet_money)
            }

            // payout main bets
            if (key === result.winner) {
                row.win_money = this.multipliers[key] * row.bet_money;
                payout += row.win_money;
                total_win += (row.win_money + row.bet_money)
            }

			// bonus
            if (key.indexOf("bonus") !== -1) {
				let k = key.replace("bonus_", "");
				if(k==result.winner || result.winner == "tie") {
					let od = this.bonusCounter(k,result);
					row.win_money = od * row.bet_money;
					oddsbonus = od?od:null;
					if(row.win_money){
						payout += row.win_money;
						total_win += row.win_money;
					}
				}
            }

			// big small
			if (key === result.size) {
				row.win_money = this.bigSmallOdds[result.size] * row.bet_money;
				payout += row.win_money;
				total_win += (row.win_money + row.bet_money);
			}
            // return money if bet if result is tie
            if (result.winner == "tie"
				&& key !== "tie"
				&& key.indexOf("pair") == -1
				&& key.indexOf("bonus") == -1
				&& key !== "big"
				&& key !== "small") {
                row.win_money = row.bet_money;
                payout += row.win_money;
                total_rolling -=  row.bet_money;
                total_win += row.bet_money
            }

            if (!row.win_money) {
                total_lost += row.bet_money;
            }

            if (row.win_money && key.indexOf("bonus") == -1) {
                row.win_money += (result.winner == "tie"
				&& key !== "tie"
				&& key.indexOf("pair") == -1
				&& key !== "big"
				&& key !== "small"
                    ? 0 : row.bet_money);
            }

            processed.push(row);
        });

        return {data: processed, total_rolling, total_bets, payout, total_lost, total_win, oddsbonus};
    },

	fnGetCardSideBetMark(winner, pairs = []) {
        let map = {
            b: "b",     // banker
            p: "p",     // player
            t: "t",     // tie
            bbp: "q",   // banker banker-pair
            bbppp: "w", // banker banker-pair player-pair
            bpp: "e",   // banker player-pair
            pbp: "f",   // player banker-pair
            pbppp: "g", //player banker-pair player-pair
            ppp: "h",   // player player-pair
            tbp: "i",   // tie banker-pair
            tbppp: "j", // tie banker-pair player-pair
            tpp: "k"    // tie player-pair
        };

        let key = winner.charAt(0) + _.map(pairs, (row) => row.charAt(0) + 'p').join('');
        return map[key]
    }
};
