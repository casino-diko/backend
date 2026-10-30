'use strict';

/*
 |--------------------------------------------------------------------------
 | Dragon-Tiger game module (see core/GameServer.js for the contract)
 |--------------------------------------------------------------------------
 */

const controller = require('./controller');
const services   = require('./services');

module.exports = {
	controller,
	services,

	// per dealer socket state (socket.gameName is set by GameServer)
	initSocket (socket) {
		socket.tableId    = null;
		socket.shoeId     = null;
		socket.roundId    = null;
		socket.roundNum   = null;
		socket.status     = null;
		socket.postStatus = null;
		socket.dealerId   = null;
		socket.realName   = null;
		socket.bettimer   = null;
		socket.name       = null;
		socket.gameInfo   = {};
		socket.latest     = [];
	}
};
