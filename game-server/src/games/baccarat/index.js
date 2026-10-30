'use strict';

/*
 |--------------------------------------------------------------------------
 | baccarat game module
 |--------------------------------------------------------------------------
 | See core/GameServer.js for the contract.
 |
 */

const controller = require('./controller');
const services   = require('./services');

module.exports = {
	controller,
	services,

	// per dealer socket round state (socket.gameName is set by GameServer)
	initSocket (socket) {
		socket.logRecorder = [];
		socket.tableId     = null;
		socket.shoeId      = null;
		socket.roundId     = null;
		socket.roundNum    = null;
		socket.status      = null;
		socket.postStatus  = null;
		socket.dealerId    = null;
		socket.bettimer    = null;
		socket.slave       = null;
		socket.markJson    = {};
		socket.markDatas   = null;
		socket.latest      = [];

		// relay between dealer pages
		socket.on('t', c => socket.nsp.emit('rd', c));
	}
};
