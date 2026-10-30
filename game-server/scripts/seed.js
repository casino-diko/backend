'use strict';

/*
 |--------------------------------------------------------------------------
 | seed
 |--------------------------------------------------------------------------
 | Idempotently fills an empty MongoDB with demo data so the stack can run
 | without production data: shared dealers / vendors / users / maintenance /
 | notice, then every enabled game's src/games/<key>/seed.js.
 |
 |   npm run seed                 (all games in GAMES)
 |   SEED_FORCE=1 npm run seed    (also re-applies game seed data)
 |
 | Afterwards running game servers are asked (regional-init on the main
 | redis) to re-publish their table list.
 |
 */

require('../src/core/console');
const conf   = require('../src/config');
const models = require('../src/core/models');

const upsertAll = (Model, rows) => Promise.all(rows.map(row =>
	Model.updateOne({ _id : row._id }, { $setOnInsert : row }, { upsert : true })));

// keep the id counters ahead of the seeded _ids
const bumpCounter = async (m, name, Model) => {
	const last = await Model.findOne({}, { _id : 1 }).sort({ _id : -1 }).lean();
	if (!last) return;
	await m.connection.collection('counters').updateOne(
		{ _id : name }, { $max : { seq : last._id } }, { upsert : true });
};

/*
 | Fields only the player front-end (web repo lobby) reads: vendor lobby
 | flags, a junket vendor with a junket player (is_junket 1) and agent
 | (is_junket 2), and a user group with agent bet ranges. They are not in the
 | game-server schemas (strict), so they go through the native driver;
 | existing documents only get the fields they lack.
 */
async function seedLobby (s) {
	const col = name => s.connection.collection(name);
	const insert = (name, rows) => Promise.all(rows.map(row =>
		col(name).updateOne({ _id : row._id }, { $setOnInsert : Object.assign({ created_at : new Date(), updated_at : new Date() }, row) }, { upsert : true })));

	const vendorLobby = {
		main_multiplier : 1, reel_yn : 0, room_info_yn : 0, is_room : 0, is_sound : '1',
		deployment_type : 'demo', lobby_type : 'normal', junket_auth : null, junket_table : null, junket_end_date : null
	};
	for (const [field, value] of Object.entries(vendorLobby)) {
		await col('vendors').updateMany({ _id : { $in : [1, 2] }, [field] : { $exists : false } }, { $set : { [field] : value } });
	}

	await insert('vendors', [Object.assign({}, vendorLobby, {
		_id : 3, vendor_name : 'demo-junket', type : 'casino', integration_type : 'transfer', currency : 'USD', multiplier : 1,
		is_active : '1', reel_active : '0', check_url : '', transfer_url : '', history_url : '',
		junket_auth     : { baccarat : { auth : 1 }, sicbo : { auth : 0 }, paigow : { auth : 0 } },
		junket_table    : { created_room : [], disable_table : [] },
		junket_end_date : new Date('2099-12-31T00:00:00Z')
	})]);

	await insert('user_groups', [
		{ _id : 1, vendor_id : 3, name : 'demo agents', ranges : [{ game : 'Baccarat', min : 10, max : 1000 }] }
	]);

	await insert('users', [
		{ _id : 4, vendor_id : 3, user_id : 'junket1', user_name : 'Junket Player', money : 100000, currency : 'USD', user_type : 'C', denomination : 1, is_active : '1', is_junket : 1, user_group_id : 1 },
		{ _id : 5, vendor_id : 3, user_id : 'agent1', user_name : 'Junket Agent', money : 100000, currency : 'USD', user_type : 'C', denomination : 1, is_active : '1', is_junket : 2, pc_redirect_url : 'http://localhost/' }
	]);

	await col('counters').updateOne({ _id : 'user_groups' }, { $max : { seq : 1 } }, { upsert : true });
}

async function seedShared () {
	const s = models.getShared();

	await upsertAll(s.dealers, [
		{ _id : 1, name : 'Anna',  real_name : 'Anna Cruz',  code : 'D0001', dealer_image : '/lobby/image/dealers/abby.png', table_name : 'T1', status : '1' },
		{ _id : 2, name : 'Bella', real_name : 'Bella Reyes', code : 'D0002', dealer_image : '/lobby/image/dealers/alice.png', table_name : 'T2', status : '1' },
		{ _id : 3, name : 'Cara',  real_name : 'Cara Santos', code : 'D0003', dealer_image : '/lobby/image/dealers/aika.png', table_name : 'T3', status : '1' }
	]);

	await upsertAll(s.vendors, [
		{ _id : 1, vendor_name : 'demo-transfer', integration_type : 'transfer', currency : 'USD', check_url : '', transfer_url : '', history_url : '' },
		{ _id : 2, vendor_name : 'demo-seamless', integration_type : 'seamless', currency : 'USD', check_url : '', transfer_url : '', history_url : '' }
	]);

	await upsertAll(s.users, [
		{ _id : 1, vendor_id : 1, user_id : 'player1', user_name : 'Player One', money : 100000, currency : 'USD', user_type : 'C', denomination : 1, is_active : '1' },
		{ _id : 2, vendor_id : 1, user_id : 'player2', user_name : 'Player Two', money : 100000, currency : 'USD', user_type : 'C', denomination : 1, is_active : '1' },
		{ _id : 3, vendor_id : 2, user_id : 'player3', user_name : 'Player Three', money : 100000, currency : 'USD', user_type : 'C', denomination : 1, is_active : '1' }
	]);

	await upsertAll(s.maintenance, [
		{ _id : 1, main_text : '', sub_text : '', status : '0', start_time : null, end_time : null }
	]);

	await upsertAll(s.notice, [
		{ _id : 1, content : 'Welcome!', time_yn : 'N', status : '0', start_time : null, end_time : null }
	]);

	await seedLobby(s);

	for (const [name, Model] of Object.entries({ dealers : s.dealers, vendors : s.vendors, users : s.users, maintenance : s.maintenance, notice : s.notice })) {
		await bumpCounter(s, name, Model);
	}
	console.log(`seeded shared db "${conf.mongo.sharedDb}"`.info);
}

async function main () {
	await models.connect();
	await seedShared();

	for (const key of conf.enabledGames) {
		const m = models.forGame(key);
		const hasTables = await m.tables.exists({});

		if (hasTables && !process.env.SEED_FORCE) {
			console.log(`${key}: already has tables, skipping (SEED_FORCE=1 to re-apply)`.warn);
			continue;
		}

		await require(`../src/games/${key}/seed`)(m, { upsertAll });
		for (const [name, Model] of Object.entries({ game_tables : m.tables, rounds : m.rounds, game_marks : m.gameMarks, info_marks : m.infoMarks, bets : m.bets, shoes : m.shoes, poker_bonus : m.bonus })) {
			await bumpCounter(m, name, Model);
		}
		console.log(`seeded ${key} db "${conf.games[key].dbName}"`.info);
	}

	await models.disconnect();
	await requestReinit();
}

// running game servers re-publish their tables (they listen on regional-init)
async function requestReinit () {
	const Redis = require('ioredis');
	const redis = new Redis(Object.assign({ lazyConnect : true, maxRetriesPerRequest : 1, retryStrategy : () => null }, conf.redis));
	try {
		await redis.connect();
		await redis.publish('regional-init', JSON.stringify({ isInit : true }));
		console.log('asked running game servers to re-publish init data'.info);
	} catch (e) {
		console.log(`redis not reachable, restart the game server to publish the new tables (${e.message})`.warn);
	} finally {
		redis.disconnect();
	}
}

main().catch(async e => {
	console.log('seed failed:'.error, e);
	await models.disconnect();
	process.exit(1);
});
