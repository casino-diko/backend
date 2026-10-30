'use strict';

/*
 |--------------------------------------------------------------------------
 | baccarat demo data
 |--------------------------------------------------------------------------
 | Two active tables, each with a road map (current shoe) and an ended
 | round so they show up in the init payload, plus the info marks.
 | Dealers 1-3, vendors and users come from scripts/seed.js.
 |
 */

const sideBets = (pair, tie, rest) => [
	{ max : String(pair), min : '5', division : 'Player Pair - Banker Pair' },
	{ max : String(tie),  min : '5', division : 'Tie' },
	{ max : String(rest), min : '5', division : 'Super 6' },
	{ max : String(rest), min : '5', division : 'Big - Small' },
	{ max : String(rest), min : '5', division : 'Bonus' }
];

const betRanges = [
	{ max : '1000',  min : '10',  status : 1, division : 'Player - Banker', side_bet : sideBets(100, 120, 100) },
	{ max : '5000',  min : '100', status : 1, division : 'Player - Banker', side_bet : sideBets(450, 600, 450) },
	{ max : '50000', min : '500', status : 1, division : 'Player - Banker', side_bet : sideBets(4250, 6250, 4250) }
];

const maintenanceInfo = () => [
	{ division : 'Periodic', status : 0, main_text : '', sub_text : '', start_time : null, end_time : null },
	{ division : 'Now',      status : 0, main_text : '', sub_text : '', start_time : null, end_time : null }
];

const maintenanceSetting = types => ({
	maintenance : types.map(type => ({ type, info : maintenanceInfo() }))
});

const noticeSetting = () => ({ status : 0, content : '', start_time : null, end_time : null, time_yn : 'N' });

const table = (id, name, types) => ({
	_id                 : id,
	game_name           : 'Baccarat',
	status              : '1',
	room_type           : 'n',
	env_setting         : {
		table_name : name,
		video      : { main : `rtmp://127.0.0.1/live/baccarat${id}`, backup : '' },
		lang       : 'english'
	},
	bet_setting         : {
		type            : types,
		betting_time    : 15,
		auto_next_round : 'N',
		delay_time      : 5,
		max_players     : 100
	},
	maintenance_setting : maintenanceSetting(types.filter(t => t != 'flippy').concat(types.includes('flippy') ? ['normal'] : [])),
	notice_setting      : noticeSetting(),
	casino_bet_ranges   : betRanges,
	sport_bet_ranges    : betRanges
});

// see betsCalculator.fnGetCardSideBetMark
const infoMarks = [
	['b', 'Banker - Banker'],
	['p', 'Player - Player'],
	['t', 'Tie - Tie'],
	['q', 'Banker - Banker Pair'],
	['w', 'Banker - Banker Pair Player Pair'],
	['e', 'Banker - Player Pair'],
	['f', 'Player - Banker Pair'],
	['g', 'Player - Banker Pair Player Pair'],
	['h', 'Player - Player Pair'],
	['i', 'Tie - Banker Pair'],
	['j', 'Tie - Banker Pair Player Pair'],
	['k', 'Tie - Player Pair'],
	['l', 'Supersix - Banker'],
	['m', 'Supersix - Banker Pair'],
	['n', 'Supersix - Banker Pair Player Pair'],
	['o', 'Supersix - Player Pair']
].map(([mark, mark_info], i) => ({ _id : i + 1, mark, mark_info, image : `mark_${mark}.png` }));

module.exports = async (models, { upsertAll }) => {
	await upsertAll(models.tables, [
		table(1, 'Baccarat 1', ['normal', 'supersix', 'bonus']),
		table(2, 'Baccarat 2', ['flippy', 'bonus'])
	]);

	await upsertAll(models.infoMarks, infoMarks);

	await upsertAll(models.gameMarks, [
		{ _id : 1, table_id : 1, mark_num : 'AA000001', mark : [
			{ natural : [], num : 7, mark : 'b' },
			{ natural : ['player'], num : 9, mark : 'p' }
		] },
		{ _id : 2, table_id : 2, mark_num : 'AA000002', mark : [] }
	]);

	await upsertAll(models.rounds, [
		{
			_id : 1, table_id : 1, dealer_id : 1, shoe_id : 1, round_num : 2, status : 'E',
			game_info   : { banker1 : '0003', banker2 : '0001', banker3 : null, player1 : '0008', player2 : '0048', player3 : null },
			game_result : { winner : 'player', pairs : [], supersix : false, size : 'small',
				bonus : { type : 'natural_player', diff : 'bonus_3' } }
		},
		{
			_id : 2, table_id : 2, dealer_id : 2, shoe_id : 2, round_num : 0, status : 'E',
			game_info   : { banker1 : null, banker2 : null, banker3 : null, player1 : null, player2 : null, player3 : null },
			game_result : null
		}
	]);
};
