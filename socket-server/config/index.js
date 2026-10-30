const fs = require('fs');
const os = require('os');
const path = require('path');

// optional .env file, never overrides variables already set in the environment
const envFile = path.join(__dirname, '..', '.env');

if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

const env = process.env;

/**
 * Parse an integer env var, falling back to the default when unset/invalid
 *
 * @param {String} value
 * @param {Number} fallback
 * @returns {Number}
 */
const toInt = (value, fallback) => {
    let parsed = parseInt(value, 10);

    return Number.isNaN(parsed) ? fallback : parsed;
};

// empty string means "no AUTH"
const toPassword = (value) => value ? value : undefined;

const redisClient = {
    host: env.REDIS_HOST || '127.0.0.1',
    port: toInt(env.REDIS_PORT, 6379),
    password: toPassword(env.REDIS_PASSWORD)
};

module.exports = {
    redis: {
        // socket server's own redis: store, socket.io adapter, socket-registrations
        client: redisClient,

        // redis the game servers publish to (game-servers channel)
        game: {
            host: env.GAME_SERVER_REDIS_HOST || redisClient.host,
            port: toInt(env.GAME_SERVER_REDIS_PORT, redisClient.port),
            password: env.GAME_SERVER_REDIS_PASSWORD !== undefined
                ? toPassword(env.GAME_SERVER_REDIS_PASSWORD)
                : redisClient.password
        }
    },

    socketServers: {
        ports: {
            http: toInt(env.HTTP_PORT, 8000)
        },
        // must be unique per socket server instance sharing the same redis
        serverName: env.APP_NAME || 'SERVER 1',
        host: env.APP_HOST || '127.0.0.1',
        workers: Math.max(1, toInt(env.WORKERS, os.availableParallelism())),
        // forward game server events to the workers (0 = credits updates only)
        shouldUpdateAndEmit: toInt(env.SHOULD_UPDATE_AND_EMIT, 1) !== 0,
        shutdownTimeout: toInt(env.SHUTDOWN_TIMEOUT_MS, 10000)
    }
};
