'use strict';

/*
 |--------------------------------------------------------------------------
 | dragon-tiger demo data
 |--------------------------------------------------------------------------
 | Two active tables, each with a road map (current shoe) and an ended
 | round so they show up in the init payload, plus the info marks used for
 | the road map. Dealers 1-3, vendors and users come from scripts/seed.js.
 |
 */

const sideBets = (tie, size, parity, suitedTie, suit, min) => [
	{ max : String(tie),       min : String(min[0]), division : 'Tie' },
	{ max : String(size),      min : String(min[1]), division : 'Big&Small' },
	{ max : String(parity),    min : String(min[1]), division : 'Odd or Even' },
	{ max : String(suitedTie), min : String(min[2]), division : 'Suited Tie' },
	{ max : String(suit),      min : String(min[0]), division : 'Suit' }
];

const betRanges = [
	{ max : '1000',  min : '10',  status : 1, division : 'Dragon-Tiger', side_bet : sideBets(100, 500, 500, 20, 150, [10, 10, 5]) },
	{ max : '5000',  min : '200', status : 1, division : 'Dragon-Tiger', side_bet : sideBets(380, 2000, 2000, 70, 480, [80, 150, 40]) },
	{ max : '50000', min : '500', status : 1, division : 'Dragon-Tiger', side_bet : sideBets(3800, 20000, 20000, 700, 4800, [300, 1500, 400]) }
];

// [Periodic, Now] (see socket-server Namespace 'maintenancechange')
const maintenanceSetting = () => [
	{ division : 'Periodic', status : 0, main_text : '', sub_text : '', start_time : null, end_time : null },
	{ division : 'Now',      status : 0, main_text : '', sub_text : '', start_time : null, end_time : null }
];

const noticeSetting = () => ({ status : 0, content : '', start_time : null, end_time : null, time_yn : 'N' });

const table = (id, name, roomType) => ({
	_id                 : id,
	game_name           : 'Dragon-Tiger',
	status              : '1',
	room_type           : roomType,
	env_setting         : {
		table_name : name,
		web_stream : `rtmp://127.0.0.1/live/dragontiger${id}`,
		video      : { main : `rtmp://127.0.0.1/live/dragontiger${id}`, backup : '' },
		lang       : 'english'
	},
	bet_setting         : {
		betting_time    : 15,
		auto_next_round : 'N',
		delay_time      : 5,
		max_players     : 100
	},
	maintenance_setting : maintenanceSetting(),
	notice_setting      : noticeSetting(),
	casino_bet_ranges   : betRanges,
	sport_bet_ranges    : betRanges
});

// "<winner> - Dragon <Big|Small> Tiger <Big|Small>" -> services.fnParseMarks -> 'dragon.10' etc.
const winners = [['Dragon', 'd'], ['Tiger', 'g'], ['Tie', 't'], ['Suited Tie', 's']];
const sizes   = [['Big', 'Big'], ['Big', 'Small'], ['Small', 'Big'], ['Small', 'Small']];
const letters = 'abcdefghijklmnop';

const infoMarks = winners.flatMap(([winner], w) => sizes.map(([dragon, tiger], s) => {
	const i = w * sizes.length + s;
	return {
		_id       : i + 1,
		mark      : letters[i],
		mark_info : `${winner} - Dragon ${dragon} Tiger ${tiger}`,
		image     : `mark_${letters[i]}.png`
	};
}));

module.exports = async (models, { upsertAll }) => {
	await upsertAll(models.tables, [
		table(1, 'Dragon-Tiger 1', 'n'),
		table(2, 'Dragon-Tiger 2', 'p')
	]);

	await upsertAll(models.infoMarks, infoMarks);

	await upsertAll(models.gameMarks, [
		{ _id : 1, table_id : 1, mark_num : 'AA000101', mark : [
			{ num : 13, mark : 'a' },
			{ num : 10, mark : 'e' }
		] },
		{ _id : 2, table_id : 2, mark_num : 'AA000102', mark : [] }
	]);

	await upsertAll(models.rounds, [
		{
			_id : 1, table_id : 1, dealer_id : 3, shoe_id : 1, round_num : 2, status : 'E',
			game_info   : { burn : '0004', dragon : '0021', tiger : '0035' },
			game_result : { winner : 'tiger', side_bets : {
				dragon : { suite : 'heart', size : 'big', parity : 'odd' },
				tiger  : { suite : 'diamond', size : 'big', parity : 'even' }
			} }
		},
		{
			_id : 2, table_id : 2, dealer_id : 5, shoe_id : 2, round_num : 0, status : 'E',
			game_info   : { burn : null, dragon : null, tiger : null },
			game_result : null
		}
	]);
};
