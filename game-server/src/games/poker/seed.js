'use strict';

/*
 |--------------------------------------------------------------------------
 | poker demo data (run through scripts/seed.js)
 |--------------------------------------------------------------------------
 | Shared dealers 1-3, vendors 1 (transfer) / 2 (seamless) and users 1-3 come
 | from scripts/seed.js. Every table gets one resulted round with its road
 | map mark: the init event only lists tables that have marks, and the dealer
 | page starts on the latest round (press "new round" to open betting).
 |
 */

const regionalRanges = require('../../core/regionalRanges');

// Poker ranges of core/regionalRanges.js (division AnteBet + Bonus / Bonusplus / Flop / Turn / River side bets)
const ranges = regionalRanges.china.Poker;

const maintenanceSetting = type => ({
	maintenance : [{
		type,
		info : [
			{ division : 'Periodic', status : 0, main_text : '', sub_text : '', start_time : null, end_time : null },
			{ division : 'Urgent',   status : 0, main_text : '', sub_text : '', start_time : null, end_time : null }
		]
	}]
});

const table = (id, type, stream) => ({
	_id         : id,
	game_name   : 'Poker',
	env_setting : {
		web_stream    : `rtmp://127.0.0.1/live/poker${id}`,
		mobile_stream : `https://127.0.0.1/hls/poker${id}.m3u8`,
		stream_name   : stream
	},
	bet_setting : {
		type,                   // string, or [main, slave] (init `slave` = type[1])
		betting_time    : 20,   // seconds
		auto_next_round : 'N',  // 'Y' : the dealer page opens the next round after delay_time
		delay_time      : 5,
		lastrounds      : 0
	},
	maintenance_setting : maintenanceSetting(Array.isArray(type) ? type[1] : type),
	notice_setting      : { status : 0, content : '', start_time : null, end_time : null },
	casino_bet_ranges   : ranges.casinoBetRange,
	sport_bet_ranges    : ranges.sportBetRange,
	room_type           : 'n',
	status              : '1'
});

// card barcodes: see cardsModule.js ('0000' AC ... '0051' KS)
const resultedRound = (id, tableId, dealerId) => ({
	_id         : id,
	table_id    : tableId,
	dealer_id   : dealerId,
	round_num   : 1,
	status      : 'E',
	// player AH KH, dealer 2C 7D, flop QH JH 3S, turn TH -> royal flush
	game_info   : { burn : ['0040', '0042', '0043'], player : ['0013', '0025'], dealer : ['0001', '0032'], flop : ['0024', '0023', '0041'], turn : '0022', river : '0045' },
	game_result : { cards : ['0013', '0025', '0024', '0023', '0022'], winner : 'player', handtype : 'Royal Flush' }
});

module.exports = async (models, { upsertAll }) => {
	await upsertAll(models.tables, [
		table(1, 'normal', 'poker-1'),
		table(2, ['normal', 'bonusplus'], 'poker-2')
	]);

	await upsertAll(models.rounds, [
		resultedRound(1, 1, 6),
		resultedRound(2, 2, 7)
	]);

	// one road map document per resulted round (mark P/D/T = player / dealer / tie)
	await upsertAll(models.gameMarks, [
		{ _id : 1, table_id : 1, round_id : 1, mark : [{ mark : 'P' }], mark_num : null },
		{ _id : 2, table_id : 2, round_id : 2, mark : [{ mark : 'P' }], mark_num : null }
	]);

	// paytables (reference data, the multipliers used by the code live in
	// cardsModule.getBonus and services.getAnteBonus)
	//   bonus_idx 1 : bonus bet (type 'r' bets)
	//   bonus_idx 2 : pocket bet (type 'b' bets, bonusplus channel)
	//   bonus_idx 3 : bonusplus, dealer did not win
	//   bonus_idx 4 : bonusplus bad beat (dealer won)
	let id = 0;
	const rows = (idx, pays) => Object.entries(pays).map(([bonus_name, multiplier]) =>
		({ _id : ++id, bonus_idx : idx, bonus_name, multiplier }));

	await upsertAll(models.bonus, [
		...rows(1, { 'AA' : 30, 'AK suited' : 25, 'AQ/AJ suited' : 20, 'AK offsuit' : 15, 'KK/QQ/JJ' : 10, 'AQ/AJ offsuit' : 5, 'pair 2-10' : 3 }),
		...rows(2, { 'AA' : 30, 'KK/QQ/JJ' : 3, 'pair 2-10' : 3 }),
		...rows(3, { 'royal flush' : 500, 'straight flush' : 50, 'four of a kind' : 10, 'full house' : 3, 'flush' : 1.5, 'straight' : 1 }),
		...rows(4, { 'royal flush' : 500, 'straight flush' : 500, 'four of a kind' : 50, 'full house' : 10, 'flush' : 8, 'straight' : 5 })
	]);

	await upsertAll(models.infoMarks, [
		{ _id : 1, mark : 'P', mark_info : 'Player wins', image : 'mark_p.png' },
		{ _id : 2, mark : 'D', mark_info : 'Dealer wins', image : 'mark_d.png' },
		{ _id : 3, mark : 'T', mark_info : 'Tie',         image : 'mark_t.png' }
	]);
};
