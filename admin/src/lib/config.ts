/*
 |--------------------------------------------------------------------------
 | config
 |--------------------------------------------------------------------------
 | Server-side settings, all from the environment.
 |
 */

const env = process.env;

const bool = (value: string | undefined, fallback = false) =>
	value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

export const GAMES = ['baccarat', 'dragontiger', 'poker'] as const;
export type Game = typeof GAMES[number];

export const GAME_LABELS: Record<Game, string> = {
	baccarat    : 'Baccarat',
	dragontiger : 'Dragon-Tiger',
	poker       : 'Poker'
};

export const config = {
	mongo : {
		uri      : env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',
		sharedDb : env.MONGO_SHARED_DB || 'nihtan_api',
		games    : {
			baccarat    : env.BACCARAT_DB || 'baccarat',
			dragontiger : env.DRAGONTIGER_DB || 'dragontiger',
			poker       : env.POKER_DB || 'poker'
		} as Record<Game, string>
	},

	admin : {
		username : env.ADMIN_USERNAME || 'admin',
		password : env.ADMIN_PASSWORD || ''
	},

	session : {
		secret : env.ADMIN_SESSION_SECRET || '',
		cookie : 'tg_admin',
		secure : bool(env.ADMIN_SESSION_SECURE),
		maxAge : 60 * 60 * 8
	}
};
