/**
 * @desc  socket server as game to clients gateways
 *
 * Master process: subscribes to the game servers' redis channel and routes messages to the
 * workers over IPC (ClusterManager). Workers: serve the socket.io namespaces, sharing the HTTP
 * port through node's cluster module. Transports are websocket-only, so a client's whole session
 * lives on a single TCP connection and no sticky-session load balancing is needed.
 *
 * @version 2.0
 * @author Joseph Dan Alinsug
 */

const cluster = require('cluster');
const http = require('http');
const Redis = require('ioredis');
const _ = require('lodash');
const moment = require('moment');
const conf = require('./config');
const ClusterManager = require('./lib/ClusterManager');
const Store = require('./lib/Store');
const XPacket = require('./lib/XPacket');

const socketServerConf = conf.socketServers;
const appName = socketServerConf.serverName;

const parseJson = (data) => {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    }
    catch (error) {
        return null;
    }
};

const createRedis = (options, label) => {
    let client = new Redis(options);
    client.on('error', (error) => console.log(`[${label}] redis error: ${error.message}`));

    return client;
};

process.on('unhandledRejection', function(err) {
    console.log('Caught exception: ' + (err && err.stack || err));
});

/*
 |--------------------------------------------------------------------------
 | Master
 |--------------------------------------------------------------------------
 */

/**
 * Group the `all` registrations of the users whose credits changed by worker pid
 *
 * @param {Array} users userInfo sent by the game server
 * @returns {Promise<Object>} {pid: [{server, id, socketId, pid, payload}]}
 */
const updateCredits = (users) => {
    return Store.hgetall('all')
    .then((rows) => {
        let temp = [];

        for (const key in rows) {
            if (!rows.hasOwnProperty(key) || key.match(/maintenance/gi)) {
                continue;
            }

            let [server, id, socketId] = key.split(':');
            let index = _.findIndex(users, (user) => {
                return parseInt(user.id) === parseInt(id);
            });

            if (index === -1) {
                continue ;
            }

            temp.push({server, id, socketId, pid: parseInt(rows[key]), payload: users[index]});
        }

        return _.groupBy(temp, 'pid');
    });
};

/**
 * Remove this server's registrations from the `all` hash, optionally only those of one worker
 *
 * @param {Number} pid worker pid, all workers when omitted
 */
const removeRegistrations = async (pid = null) => {
    let rows = await Store.hscanAll('all', `${appName}:*`);
    let keys = _.keys(pid ? _.pickBy(rows, (value) => parseInt(value) === pid) : rows);

    if (keys.length) {
        await Store.hdel('all', keys);
    }

    return keys.length;
};

const startMaster = () => {
    let shuttingDown = false;

    // Listeners for game servers
    let gameServerListener = createRedis(conf.redis.game, 'game-servers');
    let userRegListener = createRedis(conf.redis.client, 'socket-registrations');

    const fork = (name) => {
        ClusterManager.registerWorker(name, cluster.fork(), true);
    };

    console.log(`Master ${process.pid} (${appName}) starting ${socketServerConf.workers} worker(s)`);

    // Fork processes
    for (let i = 0; i < socketServerConf.workers; i++) {
        fork(`Worker ${i + 1}`);
    }

    cluster.on('message', (worker, message) => {
        ClusterManager.send(message);
    });

    cluster.on('exit', (worker, code, signal) => {
        let name = ClusterManager.findName(worker);

        // the final cleanup in shutdown() takes care of the registrations
        if (shuttingDown || !name) {
            return;
        }

        // sockets of a dead worker are gone, drop their registrations
        removeRegistrations(worker.process.pid).catch(console.log);

        console.log(`${name} (${worker.process.pid}) exited (${signal || code}), restarting`);
        setTimeout(() => !shuttingDown && fork(name), 1000);
    });

    userRegListener.on('message', (channel, raw) => {
        let data = parseJson(raw);

        if (!data || !data.data || appName !== data.data.app) {
            return;
        }

        ClusterManager.send({
            eventName: 'reject',
            socketId: data.data.socketId,
        }, data.data.pid);
    });

    gameServerListener.on('message', (channel, raw) => {
        let data = parseJson(raw);

        if (!data) {
            return;
        }

        let eventName = String(data.eventName || '').toLowerCase();

        if ((eventName.match(/displayresult/g) || eventName.match(/regionalcredits/g)) && (data.userInfo || []).length) {
            updateCredits(data.userInfo).then((rows) => {
                _.forEach(rows, (row, key) => {
                    // second parameter specifies which pid to send it to
                    ClusterManager.send({
                        eventName: 'updatecredits',
                        gameName: data.gameName,
                        tableId: data.tableId,
                        data: row
                    }, key);
                });
            }).catch(console.log);
        }

        if (!socketServerConf.shouldUpdateAndEmit) {
            return ;
        }

        // sends to a random subprocess (init goes to all of them)
        ClusterManager.send(data);
    });

    // subscribe to channel
    gameServerListener.subscribe('game-servers').then(() => console.log('Subscribed to channel game-servers'));
    userRegListener.subscribe('socket-registrations').then(() => console.log('Subscribed to channel socket-registrations'));

    const shutdown = async (signal) => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.log(`Master received ${signal}, shutting down`);

        gameServerListener.disconnect();
        userRegListener.disconnect();

        // ask workers to close their sockets, force kill after the timeout
        let workers = _.filter(cluster.workers, (worker) => !worker.isDead());
        let exited = Promise.all(_.map(workers, (worker) => new Promise((resolve) => {
            worker.once('exit', resolve);
            worker.process.kill('SIGTERM');
        })));
        let timeout = new Promise((resolve) => setTimeout(resolve, socketServerConf.shutdownTimeout).unref());

        await Promise.race([exited, timeout]);
        _.forEach(cluster.workers, (worker) => !worker.isDead() && worker.process.kill('SIGKILL'));

        try {
            let removed = await removeRegistrations();
            console.log(`Removed ${removed} registration(s) of ${appName} from the all hash`);
        } catch (error) {
            console.log(error);
        }

        await Store.quit();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
};

/*
 |--------------------------------------------------------------------------
 | Worker
 |--------------------------------------------------------------------------
 */

/**
 * Reject (disconnect on client side) previous registrations of a user
 *
 * @param {Object} data `all` hash rows {`${app}:${userId}:${socketId}`: pid}
 */
const disconnectUser = (data) => {
    _.forEach(data, (row, key) => {
        let temp = key.split(':');
        Store.client.publish('socket-registrations', JSON.stringify({
            eventName: 'reject',
            data: {
                pid: row,
                socketId: temp[temp.length -1],
                app: temp[0]
            }
        }));
    });
};

/**
 * Most recent `all` namespace socket id of a user
 *
 * @param userId
 * @returns {Promise<{socketId: (String|null), pid: (Number|null)}>}
 */
const getChatUsers = async (userId) => {
    let users = await Store.hscan('all', 0, `*:${userId}:*`);

    return Store.lastRegistration(users[1]);
};

/**
 * Handle messages from the master (game servers / registrations) and the managers page
 *
 * @param {Object|String} data
 * @param {Object} worker
 */
const handler = (data, worker) => {
    data = parseJson(data);

    if (!data || data.type == 'axm:monitor') {
        return;
    }

    if (data.eventName === 'reject') {
        if (data.socketId) {
            worker.namespaces['all'].send(data.socketId, 'data', {
                eventName: 'reject'
            });
        }
        return;
    }

    if (data.eventName == 'newround') {
        data.currentDate = moment().utc().format('YYYY-MM-DD HH:mm:ss');
    }

    if (data.eventName === 'updatecredits') {
        for (let i = 0; i < data.data.length; i++) {
            worker.namespaces['all'].send(
                data.data[i].socketId,
                'data',
                {
                    gameName: data.gameName,
                    tableId: data.tableId,
                    eventName: 'updatecredits',
                    payload: { credits: data.data[i].payload }
                }
            );
        }
        return ;
    }

    if (data.eventName !== 'init' && worker.namespaces[`${data.gameName}/${data.tableId}`]) {
        worker.namespaces[`${data.gameName}/${data.tableId}`].emitter(data);
        return;
    }

    if (data.eventName == 'mainmaintenancechange' || data.eventName == 'mainnoticechange') {
        for (const key in worker.namespaces) {
            if (key === 'managers' || key === 'Passwords' || key.match(/Rooms/gi)) {
                continue;
            }

            worker.namespaces[key].emitter(data);
        }
    }

    if (!data.tables) {
        return;
    }

    for (let i = 0; i < data.tables.length; i++) {
        if (!data.tables[i].id) {
            continue;
        }

        let name = `${data.gameName}/${data.tables[i].id}`;

        worker.updateStores(
            name,
            typeof data.tables[i] == 'object' ? data.tables[i] : {}, {
            mainNotice: typeof data.mainNotice == 'object' ? data.mainNotice : {},
            mainMaintenance: typeof data.mainMaintenance == 'object' ? data.mainMaintenance : {}
        }).catch(console.log);

        // tables announced after this worker started
        worker.ensureGameNamespace(name);
    }

    worker.removeNamespaces(data.gameName, _.map(data.tables, (row) => {
        return `${data.gameName}/${row.id}`;
    }));
};

const startWorker = () => {
    const express = require('express');
    const { Server } = require('socket.io');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const Worker = require('./lib/Worker');

    let shuttingDown = false;

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        transports: ['websocket'],
        // accept socket.io v1/v2 (engine.io protocol 3) front-end clients
        allowEIO3: true,
        // socket.io v2 default, v4 lowered it to 1MB
        maxHttpBufferSize: 1e8
    });

    // pub/sub clients for the socket.io redis adapter
    const pubClient = createRedis(conf.redis.client, 'adapter-pub');
    const subClient = pubClient.duplicate();
    subClient.on('error', (error) => console.log(`[adapter-sub] redis error: ${error.message}`));

    io.adapter(createAdapter(pubClient, subClient));

    app.get('/', (req, res) => {res.send('ok');});

    app.get('/health', (req, res) => {
        let healthy = !shuttingDown
            && Store.isReady()
            && pubClient.status === 'ready'
            && subClient.status === 'ready';

        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'unavailable',
            app: appName,
            pid: process.pid
        });
    });

    let worker = Worker(io, null);
    let all = worker.createNamespace(`all`, true);
    let manager = worker.createNamespace(`managers`, true);

    worker.createFromStore(false, manager, all);

    manager.io.on('connection', (socket) => {
        // return all data here
        worker.getAllData().then((storeData) => {
            socket.emit('data', XPacket.send({
                eventName: 'init',
                data: storeData
            }));
        });

        // manager sent events
        socket.on('data', (message) => {
            handler(message, worker);
        });
    });

    all.io.on('connection', async (socket) => {
        let namespaces = worker.getGameNamespaces();
        let promises = _.map(namespaces, (namespace) => { return namespace.generate(); });

        Promise.all(promises).then((values) => {
            // return all data here
            socket.emit('data', XPacket.send({
                eventName: 'init',
                data: values
            }));
        });

        socket.on('register', async (message, next) => {
            next = typeof next === 'function' ? next : (() => {});

            if (!message || message.id === undefined) {
                return;
            }

            let users = await Store.hscan('all', 0, `*:${message.id}:*`);
            if (users[1].length) {
                disconnectUser(Store.buildKeyValue(users[1]));
            }

            let data = {};
            data[`${appName}:${message.id}:${socket.id}`] = process.pid;
            socket.user_id = message.id;
            Store.update('all', data).catch(console.log);
            next(true);
        });

        socket.on('chat', async (message) => {
            if (!message) {
                return;
            }

            if (message.isPM) {
                let userData = await getChatUsers(message.receiver);

                if (!userData.socketId) {
                    return;
                }

                // a socket is always in the room named after its id (any worker, through the adapter)
                socket.to(userData.socketId).emit('data',
                    XPacket.send({
                        eventName : 'chatFromSocket',
                        message : message.message,
                        sender : message.sender,
                        senderName: message.senderName,
                        receiver : message.receiver,
                        namespace: message.namespace,
                        roomId : message.roomId
                    })
                );
            } else {
                all.io.emit('data',
                    XPacket.send({
                        eventName : 'roomBroadcast',
                        message : message.message,
                        token : message.token,
                        namespace: message.namespace,
                        roomId : message.roomId
                    })
                );
            }
        });

        socket.on('disconnect', () => {
            if (socket.user_id !== undefined) {
                Store.hdel('all', `${appName}:${socket.user_id}:${socket.id}`)
                .catch(console.log);
            }
        });
    });

    process.on('message', (data) => {
        handler(data, worker);
    });

    server.listen(socketServerConf.ports.http, () => {
        console.log(`Worker started ${process.pid}`, 'listening on port ' + socketServerConf.ports.http);
    });

    const shutdown = () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.log(`Worker ${process.pid} shutting down`);

        // disconnects every socket (running their disconnect handlers) and closes the http server
        io.close();

        // let the disconnect handlers' redis writes go out before closing the connections
        setTimeout(async () => {
            await Promise.all([
                Store.quit(),
                pubClient.quit().catch(() => {}),
                subClient.quit().catch(() => {})
            ]);
            process.exit(0);
        }, 1000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    // master went away
    process.on('disconnect', shutdown);
};

if (cluster.isPrimary) {
    startMaster();
} else {
    startWorker();
}
