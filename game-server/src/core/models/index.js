'use strict';

/*
 |--------------------------------------------------------------------------
 | models
 |--------------------------------------------------------------------------
 | One mongoose connection; each game uses its own database through useDb()
 | and every game shares the dealers / users / vendors database.
 |
 | Usage inside a game module:
 |   const models = require('../../core/models').forGame('baccarat');
 |   const id     = await models.nextId('rounds');
 |   await models.rounds.create({ _id : id, ... });
 |   await models.withTransaction(async session => { ... });
 |
 | Populate paths (virtuals):
 |   rounds : dealer, table, bets      bets : user, round      users : vendor
 |   gameMarks : table
 |
 */

const mongoose = require('mongoose');
const conf     = require('../../config');
const schemas  = require('./schemas');

mongoose.set('strictQuery', true);

const root = mongoose.connection;
let shared = null;
const games = {};

const counterFor = (conn) => {
	const Counter = conn.models.counter || conn.model('counter', schemas.counters());

	return async (name, session = null) => {
		const row = await Counter.findOneAndUpdate(
			{ _id : name },
			{ $inc : { seq : 1 } },
			{ upsert : true, new : true, session }
		).lean();
		return row.seq;
	};
};

const virtual = (schema, name, ref, localField, foreignField = '_id', justOne = true) =>
	schema.virtual(name, { ref, localField, foreignField, justOne });

const getShared = () => {
	if (shared) return shared;

	const conn = root.useDb(conf.mongo.sharedDb, { useCache : true });

	const vendorSchema = schemas.vendors();
	const vendors = conn.model('vendor', vendorSchema);

	const userSchema = schemas.users();
	virtual(userSchema, 'vendor', vendors, 'vendor_id');

	shared = {
		connection  : conn,
		dealers     : conn.model('dealer', schemas.dealers()),
		users       : conn.model('user', userSchema),
		vendors,
		maintenance : conn.model('maintenance', schemas.maintenance()),
		notice      : conn.model('notice', schemas.notice()),
		rooms       : conn.model('room', schemas.rooms()),
		nextId      : counterFor(conn)
	};

	return shared;
};

const forGame = (key) => {
	if (games[key]) return games[key];

	const gameConf = conf.games[key];
	if (!gameConf) throw new Error(`unknown game: ${key}`);

	const s    = getShared();
	const conn = root.useDb(gameConf.dbName, { useCache : true });

	const tableSchema = schemas.gameTables();
	const tables = conn.model('game_table', tableSchema);

	const betSchema = schemas.bets();
	virtual(betSchema, 'user', s.users, 'user_id');
	const bets = conn.model('bet', betSchema);

	const roundSchema = schemas.rounds();
	virtual(roundSchema, 'dealer', s.dealers, 'dealer_id');
	virtual(roundSchema, 'table', tables, 'table_id');
	virtual(roundSchema, 'bets', bets, '_id', 'round_id', false);
	const rounds = conn.model('round', roundSchema);
	virtual(betSchema, 'round', rounds, 'round_id');

	const markSchema = schemas.gameMarks();
	virtual(markSchema, 'table', tables, 'table_id');

	games[key] = {
		connection     : conn,
		shared         : s,
		// shared collections are exposed directly for convenience
		dealers        : s.dealers,
		users          : s.users,
		vendors        : s.vendors,
		maintenance    : s.maintenance,
		notice         : s.notice,
		rooms          : s.rooms,
		// game collections
		tables,
		rounds,
		bets,
		gameMarks      : conn.model('game_mark', markSchema),
		shoes          : conn.model('shoe', schemas.shoes()),
		infoMarks      : conn.model('info_mark', schemas.infoMarks()),
		dealerLogs     : conn.model('dealer_log', schemas.dealerLogs('dealer_logs')),
		dealerFailLogs : conn.model('dealer_fail_log', schemas.dealerLogs('dealer_fail_logs')),
		bonus          : conn.model('poker_bonus', schemas.pokerBonus()),
		nextId         : counterFor(conn),
		nextSharedId   : s.nextId,
		withTransaction
	};

	return games[key];
};

/**
 * Runs fn(session) inside a multi-document transaction (requires a replica
 * set, the docker setup runs a single node one). Retries on transient errors.
 */
async function withTransaction (fn) {
	const session = await root.startSession();
	try {
		let result;
		await session.withTransaction(async () => {
			result = await fn(session);
		});
		return result;
	} finally {
		await session.endSession();
	}
}

const connect = () => mongoose.connect(conf.mongo.uri, { serverSelectionTimeoutMS : 30000 });

const disconnect = () => mongoose.disconnect();

module.exports = { connect, disconnect, forGame, getShared, withTransaction, mongoose };
