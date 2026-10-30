'use strict';

/*
 |--------------------------------------------------------------------------
 | publisher
 |--------------------------------------------------------------------------
 | Redis pub/sub towards the socket-servers.
 |  - `game-servers`   : every game event is published here (main region and,
 |                       when enabled, the china / extra regions)
 |  - `regional-init`  : a region asks the games to re-send their init data
 |  - `socket-servers` : socket-servers report player room disconnects
 |
 */

const Redis = require('ioredis');
const conf  = require('../config');

const GAME_CHANNEL     = 'game-servers';
const REGIONAL_CHANNEL = 'regional-init';
const SOCKET_CHANNEL   = 'socket-servers';

const createClient = (name, redisConf) => {
	const client = new Redis({
		host     : redisConf.host,
		port     : redisConf.port,
		password : redisConf.password,
		retryStrategy : times => Math.min(times * 200, 5000)
	});
	client.on('ready', () => console.log(`redis [${name}] connected`.info));
	client.on('error', e => console.log(`redis [${name}] error: ${e.message}`.error));
	return client;
};

// region name -> { pub, sub }
const regions = {};

const region = (name, redisConf) => {
	regions[name] = {
		pub : createClient(`${name}:pub`, redisConf),
		sub : createClient(`${name}:sub`, redisConf)
	};
};

region('main', conf.redis);
if (conf.redisChina.status) region('china', conf.redisChina);
if (conf.redisExtra.status) region('extra', conf.redisExtra);

const listeners = { [REGIONAL_CHANNEL] : [], [SOCKET_CHANNEL] : [] };

for (const [name, { sub }] of Object.entries(regions)) {
	sub.subscribe(REGIONAL_CHANNEL, SOCKET_CHANNEL).catch(e =>
		console.log(`redis [${name}] subscribe failed: ${e.message}`.error));

	sub.on('message', (channel, message) => {
		let data;
		try {
			data = JSON.parse(message);
		} catch (e) {
			console.log(`invalid message on ${channel}: ${message}`.error);
			return;
		}
		// room disconnects are only handled from the main region
		if (channel === SOCKET_CHANNEL && name !== 'main') return;

		for (const fn of listeners[channel] || []) fn(data, name);
	});
}

const serialize = data => (typeof data === 'string') ? data : JSON.stringify(data);

module.exports = {
	regions : () => Object.keys(regions),

	/** publish to every connected region */
	publish (data) {
		const payload = serialize(data);
		for (const { pub } of Object.values(regions)) pub.publish(GAME_CHANNEL, payload);
	},

	/** publish to one region only (no-op when the region is disabled) */
	publishTo (name, data) {
		if (regions[name]) regions[name].pub.publish(GAME_CHANNEL, serialize(data));
	},

	/** fn(data, regionName) for every `regional-init` message with isInit */
	onRegionalInit (fn) {
		listeners[REGIONAL_CHANNEL].push((data, name) => data && data.isInit && fn(data, name));
	},

	/** fn(data) for every message on `socket-servers` (main region) */
	onSocketServerMessage (fn) {
		listeners[SOCKET_CHANNEL].push(fn);
	},

	async close () {
		await Promise.all(Object.values(regions).flatMap(({ pub, sub }) => [pub.quit(), sub.quit()]));
	}
};
