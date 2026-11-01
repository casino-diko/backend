/*
 |--------------------------------------------------------------------------
 | redis
 |--------------------------------------------------------------------------
 | Publishes on the game-server's `game-servers` channel, which the
 | socket-servers relay to the table's players (a voided round). One lazy
 | connection, kept across dev-server reloads.
 |
 */

import Redis from 'ioredis';
import { config } from './config';

const g = globalThis as any;

function client (): Redis {
	if (!g.__tgAdminRedis) {
		g.__tgAdminRedis = new Redis({ ...config.redis, lazyConnect : true, maxRetriesPerRequest : 2, enableOfflineQueue : true });
		g.__tgAdminRedis.on('error', (e: Error) => console.error('[admin] redis:', e.message));
	}
	return g.__tgAdminRedis;
}

/** resolves false when redis can't be reached (the change itself is already saved) */
export async function publishGameEvent (data: Record<string, unknown>): Promise<boolean> {
	try {
		await client().publish('game-servers', JSON.stringify(data));
		return true;
	} catch (e) {
		console.error('[admin] publish failed:', (e as Error).message);
		return false;
	}
}
