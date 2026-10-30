'use strict';

/*
 |--------------------------------------------------------------------------
 | poker game module (see core/GameServer.js for the contract)
 |--------------------------------------------------------------------------
 */

const controller = require('./controller');
const services   = require('./services');

module.exports = {
	controller,
	services,

	/** per dealer socket state (socket.gameName is set by GameServer) */
	initSocket (socket) {
		socket.logRecorder  = [];
		socket.tableId      = null;
		socket.shoeId       = null;
		socket.roundId      = null;
		socket.roundNum     = null;
		socket.name         = null;
		socket.dealerName   = null;
		socket.realName     = null;
		socket.gameInfo     = {
			burn   : [],
			player : [],
			dealer : [],
			flop   : [],
			turn   : null,
			river  : null
		};
		socket.status       = null;
		socket.postStatus   = null;
		socket.dealerId     = null;
		socket.bettimer     = null;
		socket.markJson     = {};
		socket.resultHolder = null;
		socket.markDatas    = null;
		socket.latest       = [];

		// dealer page relay: 't' from one dealer page is broadcast as 'rd' to every dealer page
		socket.on('t', c => socket.nsp.emit('rd', c));
	}
};
