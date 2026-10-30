'use strict';

/*
 |--------------------------------------------------------------------------
 | logger
 |--------------------------------------------------------------------------
 | Logs dealer connect / disconnect for the table and round a dealer socket
 | is currently on. Rejects when the socket never initialised a table.
 |
 */

module.exports = {
	show (event, socket) {
		if (!socket || (!socket.tableId && !socket.roundNum)) {
			return Promise.reject();
		}
		console.log(`★ [${socket.gameName}] TABLE #${socket.tableId} ${event}ED - CURRENT ROUND NUMBER : ${socket.roundNum}`.verbose);
		return Promise.resolve();
	}
};
