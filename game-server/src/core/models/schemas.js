'use strict';

/*
 |--------------------------------------------------------------------------
 | MongoDB schemas
 |--------------------------------------------------------------------------
 | Collections mirror the former MySQL tables (same collection and field
 | names, snake_case). Primary keys are numeric `_id`s allocated through the
 | `counters` collection (see models/index.js -> nextId) because table, round
 | and user ids are sent to clients as integers.
 |
 | Former JSON columns are stored as native sub-documents (Mixed), so they
 | must NOT be JSON.parse'd after reading.
 |
 */

const { Schema } = require('mongoose');

const { Mixed } = Schema.Types;

const options = (collection, extra = {}) => Object.assign({
	collection,
	versionKey : false,
	id         : false,
	timestamps : { createdAt : 'created_at', updatedAt : 'updated_at' },
	toJSON     : { virtuals : true },
	toObject   : { virtuals : true }
}, extra);

const CURRENCIES = ['CNY', 'USD', 'JPY', 'KRW', 'THB', 'MYR', 'IDR', 'RUB', 'UAH', 'GEL', 'EUR', 'GBP',
	'TRY', 'IRR', 'DGN', 'CZK', 'HUF', 'SEK', 'VND', 'HKD', 'BYN', 'INR', 'PTS'];

// ------------------------------------------------------------------ shared db

const dealers = () => new Schema({
	_id          : Number,
	name         : String,
	real_name    : String,
	dealer_image : String,
	table_image  : String,
	code         : { type : String, index : true },
	table_name   : String,
	status       : { type : String, enum : ['0', '1'], default : '1' }
}, options('dealers'));

const vendors = () => new Schema({
	_id              : Number,
	vendor_name      : String,
	type             : { type : String, enum : ['sports', 'casino', 'none'], default : 'casino' },
	integration_type : { type : String, enum : ['seamless', 'transfer'], default : 'transfer' },
	parent_id        : Number,
	ip_address       : String,
	public_key       : String,
	secret_key       : String,
	check_url        : String,
	transfer_url     : String,
	history_url      : String,
	egg              : { type : Number, default : 0 },
	egg_ratio        : { type : Number, default : 0 },
	egg_reel         : { type : Number, default : 0 },
	egg_reel_ratio   : { type : Number, default : 0 },
	reel_active      : { type : String, enum : ['0', '1'], default : '1' },
	is_active        : { type : String, enum : ['0', '1'], default : '1' },
	bsg_token        : String,
	bsg_bank_id      : Number,
	lang             : { type : String, enum : ['korea', 'english', 'japan', 'chinese'], default : 'korea' },
	currency         : { type : String, enum : CURRENCIES, default : 'KRW' },
	multiplier       : { type : Number, default : 1 }
}, options('vendors'));

const users = () => new Schema({
	_id             : Number,
	vendor_id       : { type : Number, index : true },
	user_id         : String,
	user_name       : String,
	password        : String,
	money           : { type : Number, default : 0 },
	is_active       : { type : String, enum : ['0', '1'] },
	is_online       : { type : String, enum : ['0', '1'] },
	user_type       : { type : String, enum : ['TC', 'TS', 'C', 'S', null], default : null },
	currency        : { type : String, enum : CURRENCIES.concat(null), default : null },
	created_country : String,
	connect_country : String,
	configs         : Mixed, // player settings, written by the front-end
	connect_ip      : String,
	created_ip      : String,
	deleted_at      : Date,
	denomination    : { type : Number, default : 8 }
}, options('users'));

// global maintenance banner (former nihtan_api.maintenance)
const maintenance = () => new Schema({
	_id        : Number,
	main_text  : String,
	sub_text   : String,
	status     : String,
	start_time : Date,
	end_time   : Date
}, options('maintenance', { strict : false }));

// global notice (former nihtan_api.notice)
const notice = () => new Schema({
	_id        : Number,
	content    : String,
	start_time : Date,
	end_time   : Date,
	time_yn    : String,
	status     : String
}, options('notice', { strict : false }));

// player rooms managed by the socket-server (former stored procedures USP_ROOMS_SAVE / USP_REMOVE_JUNKET_ROOM)
const rooms = () => new Schema({
	_id       : Number,
	game      : String,
	table_id  : Number,
	vendor_id : Number,
	name      : String,
	type      : String,
	users     : { type : [Number], default : [] },
	status    : { type : String, default : '1' }
}, options('rooms', { strict : false }));

// ------------------------------------------------------------------ game db

const gameTables = () => new Schema({
	_id                 : Number,
	game_name           : String,
	env_setting         : { type : Mixed, default : {} },
	bet_setting         : { type : Mixed, default : {} },
	maintenance_setting : { type : Mixed, default : {} },
	notice_setting      : { type : Mixed, default : {} },
	casino_bet_ranges   : { type : Mixed, default : [] },
	sport_bet_ranges    : { type : Mixed, default : [] },
	room_type           : { type : String, enum : ['n', 'p', 'v'], default : 'n' },
	status              : { type : String, enum : ['0', '1'], default : '1' },
	deleted_at          : Date
}, options('game_tables', { minimize : false }));

const rounds = () => new Schema({
	_id         : Number,
	table_id    : { type : Number, required : true },
	dealer_id   : Number,
	shoe_id     : Number,
	round_num   : { type : Number, required : true },
	status      : { type : String, enum : ['S', 'E', 'H', 'P'], default : 'S' },
	game_info   : { type : Mixed, default : null },
	game_result : { type : Mixed, default : null },
	modify_flag : Mixed
}, options('rounds', { minimize : false })).index({ table_id : 1, round_num : -1 });

const bets = () => new Schema({
	_id           : Number,
	round_id      : { type : Number, index : true },
	user_id       : Number,
	type          : { type : String, enum : ['r', 'b', 's', 'i', 'f'], default : 'r' },
	bet_history   : { type : Mixed, default : null },
	total_bet     : { type : Number, default : null },
	total_winning : { type : Number, default : null },
	total_win     : { type : Number, default : null },
	total_lost    : { type : Number, default : null },
	total_rolling : { type : Number, default : 0 },
	bet_range     : String,
	session_id    : String,
	bet_id        : String,
	currency      : { type : String, enum : CURRENCIES.concat(null), default : null }
}, options('bets', { minimize : false }));

// road map: one document per shoe, `mark` holds one entry per resulted round
const gameMarks = () => new Schema({
	_id      : Number,
	table_id : { type : Number, required : true },
	round_id : Number,
	mark     : { type : [Mixed], default : [] },
	mark_num : String
}, options('game_marks')).index({ table_id : 1, _id : -1 });

const shoes = () => new Schema({
	_id  : Number,
	code : String
}, options('shoes'));

const infoMarks = () => new Schema({
	_id       : Number,
	mark      : String,
	mark_info : String,
	image     : String
}, options('info_marks'));

// per round audit trail of dealer actions
const dealerLogs = (collection = 'dealer_logs') => new Schema({
	_id       : Number,
	table_id  : Number,
	round_num : Number,
	real_name : String,
	actions   : { type : [Mixed], default : [] }
}, options(collection)).index({ table_id : 1, round_num : 1 }, { unique : true });

const pokerBonus = () => new Schema({
	_id        : Number,
	bonus_idx  : { type : Number, required : true },
	bonus_name : { type : String, required : true },
	multiplier : { type : Number, required : true }
}, options('poker_bonus'));

const counters = () => new Schema({
	_id : String,
	seq : { type : Number, default : 0 }
}, { collection : 'counters', versionKey : false });

module.exports = {
	dealers, vendors, users, maintenance, notice, rooms,
	gameTables, rounds, bets, gameMarks, shoes, infoMarks, dealerLogs, pokerBonus, counters
};
