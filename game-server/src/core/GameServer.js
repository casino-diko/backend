'use strict';

/*
 |--------------------------------------------------------------------------
 | GameServer
 |--------------------------------------------------------------------------
 | One HTTP + socket.io server per game. Dealer pages (card scanner / dealer
 | UI) connect here; every dealer socket is handed to the game controller,
 | which publishes the resulting game events to the socket-servers.
 |
 | A game module (src/games/<key>/index.js) exports:
 |   controller : { fnDealerListener(socket), fnFetchMarks()? }
 |   services   : { fnGetTablesMarks(gameName) -> init payload, roomDisconnect(msg)? }
 |   initSocket(socket) : sets the per dealer socket state
 |
 */

const http      = require('http');
const express   = require('express');
const _         = require('lodash');
const { Server } = require('socket.io');
const publisher = require('./publisher');
const logger    = require('./logger');
const regionalRange = require('./regionalRanges');

const REGION_CHINA = 'china';

class GameServer {
	constructor (gameConf, game) {
		this.conf     = gameConf;
		this.gameName = gameConf.gameName;
		this.game     = game;
		this.app      = express();
		this.server   = http.createServer(this.app);
		this.io       = new Server(this.server, {
			allowEIO3 : true, // dealer pages still ship socket.io v1/v2 clients
			cors      : { origin : true, credentials : true }
		});
	}

	start () {
		this.app.get('/', (req, res) => res.send(`${this.gameName}: GAME ON!`));
		this.app.get('/health', (req, res) => res.json({ status : 'ok', game : this.gameName }));

		this.io.on('connection', socket => this.onDealerConnection(socket));

		publisher.onRegionalInit((data, region) => this.broadcastInit(region));
		publisher.onSocketServerMessage(m => {
			if (m.gameName !== this.gameName || !this.game.services.roomDisconnect) return;

			this.game.services.roomDisconnect(m)
				.then(() => console.log(`[${this.gameName}] room ${m.roomId} disconnected`.info))
				.catch(e => console.log(`[${this.gameName}] room disconnect failed`.error, e));
		});

		this.broadcastInit();

		return new Promise(resolve => this.server.listen(this.conf.port, () => {
			console.log(`${this.gameName} game server listening on port ${this.conf.port}`.verbose);
			resolve();
		}));
	}

	onDealerConnection (socket) {
		socket.gameName = this.gameName;
		this.game.initSocket(socket);

		if (this.game.controller.fnFetchMarks) {
			this.game.controller.fnFetchMarks();
		}
		this.game.controller.fnDealerListener(socket);

		socket.on('disconnect', () => {
			logger.show('DISCONNECT', socket).catch(() => console.log(`[${this.gameName}] socket disconnected`));
		});
	}

	/**
	 * Sends the table list (init event) to the socket-servers. Without a
	 * region every region gets it; china receives its own bet ranges.
	 */
	broadcastInit (region = null) {
		return this.game.services.fnGetTablesMarks(this.gameName).then(data => {
			console.log(`[${this.gameName}] init published (${region || 'all regions'})`.info);

			const targets = region ? [region] : publisher.regions();
			for (const target of targets) {
				publisher.publishTo(target, target === REGION_CHINA ? this.toChina(data) : data);
			}
		}).catch(e => console.log(`[${this.gameName}] init failed`.error, e));
	}

	toChina (data) {
		const ranges = regionalRange[REGION_CHINA] && regionalRange[REGION_CHINA][data.gameName];
		if (!ranges) return data;

		const copy = _.cloneDeep(data);
		copy.tables = _.map(copy.tables, table => Object.assign(table, {
			sportBetRanges  : ranges.sportBetRange,
			casinoBetRanges : ranges.casinoBetRange
		}));
		return copy;
	}

	stop () {
		return new Promise(resolve => this.io.close(() => resolve()));
	}
}

module.exports = GameServer;
