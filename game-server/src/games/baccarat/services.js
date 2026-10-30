"use strict";

/*
 |--------------------------------------------------------------------------
 | services v1.0
 |--------------------------------------------------------------------------
 | Author : Shinji Escorido
 | Service module/component for processing model datas
 |
 */

const _      = require("lodash");
const moment = require("moment");
const deck   = require("./cardsModule");
const Cards  = require("./cards");
const models = require("./db.js");
const conf   = require("../../config");

const GAME_NAME = conf.games.baccarat.gameName;

// game_info keys in dealing order (index 2 of each hand is the third card)
const CARD_SLOTS = ["banker1", "banker2", "banker3", "player1", "player2", "player3"];

const emptyCards = () => _.zipObject(CARD_SLOTS, _.times(CARD_SLOTS.length, _.constant(null)));

// DATE_FORMAT(x, '%Y-%m-%d %H:%i:00')
const formatMinute = date => date ? moment(date).utcOffset(0).format("YYYY-MM-DD HH:mm:00") : null;

const latestPerTable = (Model, tableIds) => Model.aggregate([
    { $match : { table_id : { $in : tableIds } } },
    { $sort  : { _id : -1 } },
    { $group : { _id : "$table_id", doc : { $first : "$$ROOT" } } }
]).then(rows => _.fromPairs(_.map(rows, row => [row._id, row.doc])));

module.exports = {
    fnFetchMarks () {
        return models.infoMarks.find({}).lean().then(marks => {
            let markData = {};

            _.forEach(marks, value => {
                let splitInfo = (value.mark_info || "").trim().split(" - ");

                if (splitInfo.length > 1) {
                    let markTransform = splitInfo[1].toLowerCase().replace(/ /g, "");
                    markTransform = markTransform.replace(/dragon/g, "");
                    markTransform = markTransform.replace(/tiger/g, "");
                    markTransform = markTransform.replace(/big/g, "1");
                    markTransform = markTransform.replace(/small/g, "0");
                    markData[splitInfo[0].toLowerCase() + "." + markTransform] = value.mark;
                }
            });

            return markData;
        }).catch(() => Promise.reject("Error: fetch marks"));
    },

    /**
     * Toggles bet_setting.auto_next_round, resolves the delay to use (0 when off).
     */
    async fnProcessAutoNextRound (searchId) {
        let table = await models.tables.findById(parseInt(searchId)).lean();
        if (!table) {
            throw "Error: auto next round";
        }

        let settings = table.bet_setting || {};
        let autoNextRound = (settings.auto_next_round == "Y") ? "N" : "Y";

        await models.tables.updateOne({ _id : table._id }, { $set : { "bet_setting.auto_next_round" : autoNextRound } });

        return (autoNextRound == "Y") ? settings.delay_time : 0;
    },

    /**
     * Clears every card of the round and puts it back in progress.
     */
    fnProcessDeleteCard (round_num, table_id) {
        return models.rounds.updateMany(
            // a settled round must not be reopened, a second displayresults would pay it out again
            { round_num : parseInt(round_num), table_id : parseInt(table_id), status : { $ne : "E" } },
            { $set : { game_info : emptyCards(), status : "P" } }
        ).then(() => true);
    },

    async fnProcessNewRound (roundNum, currentTableId, dealerId, shoeId) {
        let round_num = parseInt(roundNum) + 1;
        let table_id  = parseInt(currentTableId);

        if (isNaN(round_num) || isNaN(table_id)) {
            throw "Error: new round";
        }

        try {
            let round = await models.rounds.create({
                _id         : await models.nextId("rounds"),
                table_id,
                dealer_id   : isNaN(parseInt(dealerId)) ? null : parseInt(dealerId),
                shoe_id     : isNaN(parseInt(shoeId)) ? null : parseInt(shoeId),
                round_num,
                status      : "S",
                game_info   : emptyCards(),
                game_result : null,
                modify_flag : null
            });

            return { id : round._id, round_num };
        } catch (e) {
            console.log(`new round: ${e.message}`.error);
            throw "Error: new round";
        }
    },

    hasPair (data) {
        data = _.pickBy(data, (row, key) => {
            return parseInt(key) !== 2;
        });

        return _.filter(_.countBy(data, (card) => {
            return card.value;
        }), (o) => {
            return o >= 2
        }).length;
    },

    isNatural (data) {
        data = _.pickBy(data, (row, key) => {
            return parseInt(key) !== 2;
        });

        let temp = _.reduce(data, (sum, card) => {
            return sum + card.bcValue;
        }, 0) % 10;
        return [8, 9].indexOf(temp) !== -1;
    },

    /**
     * Pure result computation from a round document ({ round_num, table_id,
     * game_info, created_at, updated_at }) and its bets.
     */
    fnComputeResult (round, bets = []) {
        let cards = round.game_info || {};
        let naturalType = null;

        let result = {
            winner      : null,
            round_no    : round.round_num,
            table       : round.table_id,
            created_at  : round.created_at,
            resulted_at : round.updated_at,
            pairs       : [],
            natural     : [],
            banker      : {total : 0, cards : []},
            player      : {total : 0, cards : []},
            bets,
            supersix    : false,
            bonus       : false,
            size        : _.filter(cards, d => d).length > 4 ? "big" : "small"
        };

        _.forEach(CARD_SLOTS, key => {
            let value = cards[key];
            if (value === null || value === undefined) {
                return;
            }

            let temp = key.slice(0, -1);
            result[temp].cards.push(new deck(value));
            result[temp].total = (result[temp].total + Cards.getCardValue(value)) % 10;
        });

        if (this.hasPair(result.banker.cards)) {
            result.pairs.push("banker");
        }

        if (this.hasPair(result.player.cards)) {
            result.pairs.push("player");
        }

        if (this.isNatural(result.player.cards)) {
            result.natural.push("player");
            naturalType = "natural";
        }

        if (this.isNatural(result.banker.cards)) {
            result.natural.push("banker");
            naturalType = "natural";
        }

        result.winner = result.banker.total === result.player.total ? "tie" : result.banker.total > result.player.total ? "banker" : "player";

        //supersix result calculation
        result.supersix = (result.winner == "banker" && result.banker.total == 6);

        //bonus result calculation
        result.bonus = {
            type : (naturalType) ? naturalType + "_" + result.winner : null,
            diff : (result.winner == "tie") ? null : result.winner == "banker" ? "bonus_" + (result.banker.total - result.player.total).toString() : "bonus_" + (result.player.total - result.banker.total).toString()
        };

        return result;
    },

    /**
     * Loads the round's bets in the shape betsCalculator expects
     * (bet + user + user.vendor, `id` fields as in the former SQL rows).
     */
    async fnGetRoundBets (roundId) {
        let bets = await models.bets.find({ round_id : roundId }, {
            round_id : 1, type : 1, user_id : 1, bet_history : 1, total_bet : 1, total_winning : 1,
            total_rolling : 1, bet_range : 1, bet_id : 1, session_id : 1, created_at : 1, currency : 1
        }).sort({ _id : 1 }).lean();

        if (!bets.length) {
            return [];
        }

        let users = await models.users.find({ _id : { $in : _.uniq(_.map(bets, "user_id")) } }, {
            vendor_id : 1, user_id : 1, user_name : 1, money : 1, user_type : 1, currency : 1, denomination : 1
        }).lean();

        let vendors = await models.vendors.find({ _id : { $in : _.uniq(_.map(users, "vendor_id")) } }, {
            type : 1, integration_type : 1, currency : 1, multiplier : 1
        }).lean();

        let vendorsById = _.keyBy(_.map(vendors, ({ _id, ...v }) => Object.assign({ id : _id }, v)), "id");
        let usersById = _.keyBy(_.map(users, ({ _id, ...u }) => Object.assign({ id : _id }, u, {
            vendor : vendorsById[u.vendor_id] || null
        })), "id");

        return _.map(bets, ({ _id, ...bet }) => Object.assign({ id : _id }, bet, {
            user : usersById[bet.user_id] || null
        }));
    },

    async fnGetResults (tableId, roundNum) {
        let round;

        try {
            round = await models.rounds.findOne({ table_id : parseInt(tableId), round_num : parseInt(roundNum) }).lean();
        } catch (e) {
            throw "Error: get results error - fnGetResults";
        }

        if (!round) {
            throw false;
        }

        let cards = round.game_info || {};
        if (!cards.banker1 || !cards.banker2 || !cards.player1 || !cards.player2) {
            throw "inc";
        }

        if (round.status == "E") {
            throw "doubleresult";
        }

        try {
            return this.fnComputeResult(round, await this.fnGetRoundBets(round._id));
        } catch (e) {
            throw "Error: get results error - fnGetResults";
        }
    },

    /**
     * Sets the status of a round that is still open for bets (S).
     * Resolves even when no round matched (former UPDATE semantics).
     */
    fnSetRoundStatus (tableId, roundNum, status) {
        return models.rounds.updateMany(
            { round_num : parseInt(roundNum), table_id : parseInt(tableId), status : "S" },
            { $set : { status } }
        ).then(() => true).catch(() => Promise.reject("Error: set round status"));
    },

    /**
     * Description: If round status is P then set to S
     */
    fnResetTimer (tableId, roundNum) {
        return models.rounds.updateMany(
            { round_num : parseInt(roundNum), table_id : parseInt(tableId), status : "P" },
            { $set : { status : "S" } }
        ).then(() => true).catch(() => Promise.reject("Error: set round status"));
    },

    async fnGetCurrentRoundDatas (tableId) {
        let data, table, dealer, markData;

        try {
            data = await models.rounds.findOne({ table_id : parseInt(tableId) })
                .sort({ created_at : -1, _id : -1 }).lean();

            if (data) {
                [table, dealer, markData] = await Promise.all([
                    models.tables.findById(data.table_id, { bet_setting : 1, env_setting : 1 }).lean(),
                    data.dealer_id === null || data.dealer_id === undefined ? null
                        : models.dealers.findById(data.dealer_id, { real_name : 1, name : 1, dealer_image : 1 }).lean(),
                    // the latest road map is the current shoe
                    models.gameMarks.findOne({ table_id : data.table_id }, { _id : 1 }).sort({ _id : -1 }).lean()
                ]);
            }
        } catch (e) {
            console.log(`init data: ${e.message}`.error);
            throw "Error: init data";
        }

        if (!data || !table) {
            throw "Error: init data";
        }

        let gameInfo = data.game_info || {};
        let betSettings = table.bet_setting || {};
        let postStatus = data.status;

        // get post status logic
        if (data.status == "H") {
            if (data.game_result) {
                postStatus = "E";
            }
            else {
                postStatus = !_.filter(gameInfo, (row) => { return row }).length ? "S" : "P";
            }
        }

        return {
            roundId       : data._id,
            roundNum      : data.round_num,
            dealer        : dealer ? {
                id           : dealer._id,
                real_name    : dealer.real_name,
                name         : dealer.name,
                dealer_image : dealer.dealer_image
            } : null,
            autonextround : (betSettings.auto_next_round == "Y") ? betSettings.delay_time : 0,
            bettimer      : betSettings.betting_time || 0,
            type          : betSettings.type,
            betSettings,
            envSetting    : table.env_setting,
            table         : table._id,
            status        : data.status,
            gameInfo,
            postStatus,
            shoeId        : markData ? markData._id : null,
            done          : !!_.size(data.game_result)
        };
    },

    /**
     * Resolves, like the former callback, with:
     *  "shoeburncard" | false | "roundStatusError" | <new shoe id> |
     *  dealerchange payload | inputitem payload
     */
    async fnProcessCard (value, type, roundNum, roundId, tableId, gameName, status) {
        if (type == "shoeburncard") {
            return "shoeburncard";
        }

        try {
            if (type == "dealer_id") {
                return await this.fnChangeDealer(value, roundNum, roundId, tableId, gameName, status);
            }

            if (type == "shoe") {
                let shoe = await models.gameMarks.create({
                    _id      : await models.nextId("game_marks"),
                    table_id : parseInt(tableId),
                    mark     : [],
                    mark_num : String(value)
                });
                return shoe._id;
            }

            //== if not dealer save to round as item
            if (!CARD_SLOTS.includes(type)) {
                return false;
            }

            let filter = { table_id : parseInt(tableId), round_num : parseInt(roundNum) };
            let round = await models.rounds.findOne(filter, { status : 1 }).lean();

            if (!round) {
                return false;
            }

            if (round.status == "S") {
                return "roundStatusError";
            }

            // former JSON_SET(game_info, "$.<type>", value) ... AND status = "P"
            await models.rounds.updateMany(
                Object.assign({ status : "P" }, filter),
                { $set : { [`game_info.${type}`] : String(value) } }
            );

            let r = await models.rounds.findOne(filter, { game_info : 1 }).lean();

            return {
                value,
                type,
                gameName,
                roundId,
                eventName : "inputitem",
                tableId,
                roundNum,
                gameInfo  : r.game_info
            };
        } catch (e) {
            console.log(`process card: ${e.message}`.error);
            return false;
        }
    },

    async fnChangeDealer (code, roundNum, roundId, tableId, gameName, status) {
        let dealer = await models.dealers.findOne({ code : String(code) }, { name : 1, dealer_image : 1, real_name : 1 }).lean();

        if (!dealer) {
            return false;
        }

        let dealerChangeData = {
            gameName,
            eventName   : "dealerchange",
            dealerId    : dealer._id,
            dealerName  : dealer.name,
            roundId,
            roundNum,
            tableId,
            dealerImage : dealer.dealer_image,
            data        : {
                dealerImage   : dealer.dealer_image,
                currentDealer : dealer.name
            }
        };

        // the round's dealer can only change while it is open for bets
        if (status != "S") {
            return dealerChangeData;
        }

        let tableName = `${gameName}# ${tableId}`;

        await models.withTransaction(async session => {
            // 1. the previous dealer of this table leaves it
            await models.dealers.updateMany({ table_name : tableName }, { $set : { table_name : null } }, { session });

            // 2. round + dealer are updated together (former UPDATE rounds JOIN dealers)
            let res = await models.rounds.updateMany(
                { table_id : parseInt(tableId), round_num : parseInt(roundNum) },
                { $set : { dealer_id : dealer._id } },
                { session }
            );

            if (res.matchedCount) {
                await models.dealers.updateOne({ _id : dealer._id }, { $set : { table_name : tableName } }, { session });
            }
        });

        return dealerChangeData;
    },

    /**
     * Init payload for the socket-servers: every active table with its
     * current shoe road map, latest round and its dealer.
     */
    async fnGetTablesMarks (gameName) {
        let [maintenance, notice, tables] = await Promise.all([
            models.maintenance.findOne({}).sort({ _id : -1 }).lean(),
            models.notice.findOne({}).sort({ _id : -1 }).lean(),
            models.tables.find({ game_name : GAME_NAME, status : "1" }).sort({ _id : 1 }).lean()
        ]);

        // the former query cross joined the maintenance row: no row, no tables
        if (!maintenance) {
            return { eventName : "init", gameName, mainMaintenance : {}, mainNotice : {}, tables : [] };
        }

        let tableIds = _.map(tables, "_id");
        let [marks, rounds] = await Promise.all([
            latestPerTable(models.gameMarks, tableIds),
            latestPerTable(models.rounds, tableIds)
        ]);

        let dealerIds = _.uniq(_.compact(_.map(rounds, "dealer_id")));
        let dealers = _.keyBy(await models.dealers.find({ _id : { $in : dealerIds } }).lean(), "_id");

        let result = [];

        _.each(tables, table => {
            let mark = marks[table._id];
            let round = rounds[table._id];
            let dealer = round && dealers[round.dealer_id];

            // inner joins: tables without road map, round or dealer are left out
            if (!mark || !round || !dealer) {
                return;
            }

            let betSetting = table.bet_setting || {};
            let sType = null;
            let sSlave = [];

            if (Array.isArray(betSetting.type)) {
                _.each(betSetting.type, type => {
                    if (type == "normal" || type == "flippy") {
                        sType = type;
                    }

                    if (type == "supersix" || type == "insurance" || type == "bonus") {
                        sSlave.push(type);
                    }
                });
            }
            else {
                sType = betSetting.type;
            }

            result.push({
                id                 : table._id,
                shoeNumber         : mark.mark_num,
                roundNum           : round.round_num,
                currentDealer      : dealer.name,
                dealerId           : dealer._id,
                dealerImage        : dealer.dealer_image,
                envSetting         : table.env_setting,
                type               : sType,
                slave              : sSlave,
                sportBetRanges     : table.sport_bet_ranges,
                casinoBetRanges    : table.casino_bet_ranges,
                maintenanceSetting : table.maintenance_setting,
                noticeSetting      : table.notice_setting,
                gameInfo           : round.game_info,
                gameResult         : round.game_result,
                gameMarks          : mark.mark,
                roomType           : table.room_type,
                roundStatus        : round.status
            });
        });

        return {
            eventName       : "init",
            gameName,
            mainMaintenance : result.length ? {
                mainText : maintenance.main_text,
                subText  : maintenance.sub_text,
                status   : maintenance.status
            } : {},
            mainNotice      : result.length ? {
                start_time : notice ? formatMinute(notice.start_time) : null,
                end_time   : notice ? formatMinute(notice.end_time) : null,
                content    : notice ? notice.content : null,
                time_yn    : notice ? notice.time_yn : null,
                status     : notice ? notice.status : null
            } : {},
            tables          : result
        };
    },

    /**
     * A player left a room (formerly USP_ROOMS_SAVE('A', ...)); junket rooms
     * are removed altogether (formerly USP_REMOVE_JUNKET_ROOM).
     */
    roomDisconnect (data) {
        let tasks = [
            models.rooms.updateOne({ _id : parseInt(data.roomId) }, { $pull : { users : parseInt(data.userId) } })
        ];

        if (data.type == "J") {
            tasks.push(models.rooms.deleteOne({
                vendor_id : parseInt(data.vendorId),
                name      : `${data.gameType}-${data.tableId}`
            }));
        }

        return Promise.all(tasks);
    },

    fnGetTables (gameName) {
        return models.tables.find({}, { _id : 1 }).sort({ _id : 1 }).lean().then(tables => ({
            eventName : "init",
            gameName,
            tables    : _.map(tables, "_id")
        }));
    },

    /**
     * What a scanned value is: "card", "dealer" (dealer code), "shoe"
     * (8 chars starting with AA) or "error".
     */
    async fnCardType (value) {
        let cardCheck = new deck(value);

        if (cardCheck.checkCard(value)) {
            return "card";
        }

        value = String(value);

        try {
            let data = await models.dealers.exists({ code : value, status : "1" });

            if (!data && (value.length !== 8 || value.substring(0, 2) !== "AA")) {
                return "error";
            }

            return data ? "dealer" : "shoe";
        } catch (e) {
            return "Internal Server Error";
        }
    }
};
