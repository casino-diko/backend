'use strict';

/*
 |--------------------------------------------------------------------------
 | game-server entry point
 |--------------------------------------------------------------------------
 | Hosts every game listed in GAMES (default: all) in this process, each on
 | its own port, after connecting to MongoDB.
 |
 */

require('./core/console');
const conf       = require('./config');
const models     = require('./core/models');
const publisher  = require('./core/publisher');
const GameServer = require('./core/GameServer');

const servers = [];

async function main () {
	const unknown = conf.enabledGames.filter(key => !conf.games[key]);
	if (unknown.length) {
		throw new Error(`unknown game(s) in GAMES: ${unknown.join(', ')}`);
	}

	await models.connect();
	console.log(`mongodb connected (${conf.mongo.uri.replace(/\/\/[^@]*@/, '//***@')})`.info);

	for (const key of conf.enabledGames) {
		const server = new GameServer(conf.games[key], require(`./games/${key}`));
		await server.start();
		servers.push(server);
	}
}

async function shutdown (signal) {
	console.log(`${signal} received, shutting down`.warn);
	const force = setTimeout(() => process.exit(1), 10000);
	force.unref();

	await Promise.allSettled(servers.map(s => s.stop()));
	await Promise.allSettled([publisher.close(), models.disconnect()]);
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.log('unhandled rejection:'.error, e));

main().catch(e => {
	console.log('game server failed to start:'.error, e);
	process.exit(1);
});
