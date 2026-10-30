'use strict';

/*
 |--------------------------------------------------------------------------
 | config
 |--------------------------------------------------------------------------
 | All settings come from the environment (an optional .env file is loaded
 | for local development). Each game gets its own HTTP/socket.io port and
 | its own MongoDB database; dealers, users and vendors live in the shared
 | database.
 |
 */

require('dotenv').config({ quiet: true });

const env = process.env;

const bool = (value, fallback = false) => {
	if (value === undefined || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const redisConf = (prefix, defaults = {}) => ({
	host     : env[`${prefix}_HOST`] || defaults.host || '127.0.0.1',
	port     : parseInt(env[`${prefix}_PORT`] || defaults.port || 6379),
	password : env[`${prefix}_PASSWORD`] || undefined
});

const games = {
	baccarat : {
		key      : 'baccarat',
		gameName : 'Baccarat',
		port     : parseInt(env.BACCARAT_PORT || 8007),
		dbName   : env.BACCARAT_DB || 'baccarat'
	},
	dragontiger : {
		key      : 'dragontiger',
		gameName : 'Dragon-Tiger',
		port     : parseInt(env.DRAGONTIGER_PORT || 8008),
		dbName   : env.DRAGONTIGER_DB || 'dragontiger'
	},
	poker : {
		key      : 'poker',
		gameName : 'Poker',
		port     : parseInt(env.POKER_PORT || 8009),
		dbName   : env.POKER_DB || 'poker'
	}
};

module.exports = {
	// comma separated list of games this process hosts
	enabledGames : (env.GAMES || Object.keys(games).join(','))
		.split(',').map(g => g.trim().toLowerCase()).filter(Boolean),
	games,

	mongo : {
		uri      : env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
		sharedDb : env.MONGO_SHARED_DB || 'nihtan_api'
	},

	redis : redisConf('REDIS'),
	redisChina : Object.assign({ status : bool(env.REDIS_CHINA_STATUS) }, redisConf('REDIS_CHINA')),
	redisExtra : Object.assign({ status : bool(env.REDIS_EXTRA_STATUS) }, redisConf('REDIS_EXTRA')),

	// round results are POSTed here; sending is skipped when empty
	apiHistoryUrl : env.API_HISTORY_URL || ''
};
