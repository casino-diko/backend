/*
 |--------------------------------------------------------------------------
 | MongoDB
 |--------------------------------------------------------------------------
 | Same databases as the game-server (backend repo:
 | game-server/src/core/models/schemas.js): the shared database for users and
 | vendors, plus one database per game for rounds and bets. Schemas are
 | non-strict because the player front-end stores extra fields on users.
 |
 | `transactions` (shared database) is owned by this service: one document
 | per credit adjustment, written in the same MongoDB transaction as the
 | users.money change. `request_id` is unique so a resubmitted form can't
 | apply the same adjustment twice.
 |
 */

import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import { config, GAMES, type Game } from './config';

const schema = (collection: string, fields: Record<string, any>) => new Schema(
	Object.assign({ _id : Number }, fields),
	{
		collection,
		strict     : false,
		versionKey : false,
		id         : false,
		timestamps : { createdAt : 'created_at', updatedAt : 'updated_at' }
	}
);

const model = (conn: Connection, name: string, s: () => Schema): Model<any> =>
	conn.models[name] || conn.model(name, s());

const counter = (conn: Connection) => {
	const Counter: Model<any> = conn.models.counter || conn.model('counter',
		new Schema({ _id : String, seq : { type : Number, default : 0 } }, { collection : 'counters', versionKey : false }));

	return async (name: string, session: mongoose.ClientSession | null = null): Promise<number> => {
		const row: any = await Counter.findOneAndUpdate({ _id : name }, { $inc : { seq : 1 } }, { upsert : true, new : true, session }).lean();
		return row.seq;
	};
};

const transactionSchema = () => schema('transactions', {
	user_id        : { type : Number, required : true },
	vendor_id      : Number,
	type           : { type : String, enum : ['credit', 'debit'], required : true },
	amount         : { type : Number, required : true },
	balance_before : Number,
	balance_after  : Number,
	currency       : String,
	note           : String,
	admin          : String,
	request_id     : String
})
	.index({ user_id : 1, _id : -1 })
	.index({ request_id : 1 }, { unique : true, partialFilterExpression : { request_id : { $type : 'string' } } });

const sharedModels = (conn: Connection) => ({
	connection   : conn,
	users        : model(conn, 'user', () => schema('users', { vendor_id : Number, user_id : String, user_name : String, money : Number, currency : String })),
	vendors      : model(conn, 'vendor', () => schema('vendors', { vendor_name : String, integration_type : String, currency : String })),
	transactions : model(conn, 'transaction', transactionSchema),
	// the brand the player site shows (lib/brand.ts; the web repo's src/lib/brand.ts reads them)
	settings     : model(conn, 'setting', () => new Schema({ _id : String }, { collection : 'settings', strict : false, versionKey : false })),
	brandFiles   : model(conn, 'brand_file', () => new Schema({ _id : String, content_type : String, data : Buffer, version : Number }, { collection : 'brand_files', strict : false, versionKey : false })),
	nextId       : counter(conn)
});

const gameModels = (conn: Connection) => ({
	tables : model(conn, 'game_table', () => schema('game_tables', { game_name : String })),
	rounds : model(conn, 'round', () => schema('rounds', { table_id : Number, round_num : Number, status : String })),
	bets   : model(conn, 'bet', () => schema('bets', { round_id : Number, user_id : Number, total_bet : Number, total_win : Number }))
});

type Shared = ReturnType<typeof sharedModels>;
type GameDb = ReturnType<typeof gameModels>;

export type Db = {
	shared : Shared;
	games  : Record<Game, GameDb>;
	withTransaction : <T>(fn: (session: mongoose.ClientSession) => Promise<T>) => Promise<T>;
};

// survive dev-server hot reloads
const g = globalThis as any;
g.__tgAdminMongo = g.__tgAdminMongo || { connecting : null as Promise<unknown> | null, db : null as Db | null };

async function withTransaction<T> (fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
	const session = await mongoose.startSession();
	try {
		let result!: T;
		await session.withTransaction(async () => {
			result = await fn(session);
		});
		return result;
	} finally {
		await session.endSession();
	}
}

export async function getDb (): Promise<Db> {
	if (g.__tgAdminMongo.db) return g.__tgAdminMongo.db;

	if (!g.__tgAdminMongo.connecting) {
		mongoose.set('strictQuery', false);
		g.__tgAdminMongo.connecting = mongoose.connect(config.mongo.uri, { serverSelectionTimeoutMS : 15000 })
			.catch(e => { g.__tgAdminMongo.connecting = null; throw e; });
	}
	await g.__tgAdminMongo.connecting;

	const root = mongoose.connection;
	const games = {} as Record<Game, GameDb>;
	for (const key of GAMES) {
		games[key] = gameModels(root.useDb(config.mongo.games[key], { useCache : true }));
	}

	const shared = sharedModels(root.useDb(config.mongo.sharedDb, { useCache : true }));
	// the unique request_id index is the double-submit protection, it must exist before the first adjustment
	await shared.transactions.createIndexes();

	g.__tgAdminMongo.db = { shared, games, withTransaction };
	return g.__tgAdminMongo.db;
}
