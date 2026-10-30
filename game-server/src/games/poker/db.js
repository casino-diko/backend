'use strict';

// poker database (rounds, bets, game_tables, game_marks, poker_bonus, ...)
// plus the shared dealers / users / vendors collections
module.exports = require('../../core/models').forGame('poker');
