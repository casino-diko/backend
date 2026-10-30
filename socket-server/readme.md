# Socket Server

> Acting as **socket/stream gateways** for all game servers and clients.


Clustered [socket.io](https://socket.io/) 4 server (websocket transport only) for [NodeJS](https://nodejs.org) 22.
Game servers publish JSON events on the Redis channel `game-servers`; the master process subscribes to it (and to
`socket-registrations`) and routes each message over IPC to the workers (`lib/ClusterManager.js`). Every worker serves
one namespace per table (`/<gameName>/<tableId>`, `lib/Namespace.js`) plus the `/all` (lobby / multi-bet) and
`/managers` namespaces, and broadcasts across workers and socket server instances through
`@socket.io/redis-adapter`. Namespace and user state lives in Redis (`lib/Store.js`, ioredis). Room removals are
published on `socket-servers` for the game servers.

Payloads to clients are encoded with `lib/XPacket.js` (lz-string UTF16 + `lib/XCrypto.js` AES). `allowEIO3` is
enabled, so socket.io v1/v2 front-end clients keep connecting alongside v3/v4 clients.

![](socketDiagram.jpg)

## Running locally

Requires Node 22 and a Redis server.

```sh
npm install
cp .env.example .env   # optional, environment variables take precedence over .env
REDIS_HOST=127.0.0.1 REDIS_PORT=6379 npm start
```

- `GET /health` returns `200 {"status":"ok"}` when the answering worker's Redis connections are ready, `503` otherwise.
- `SIGTERM` / `SIGINT` shut down gracefully: workers disconnect their sockets, then the master removes this server's
  (`APP_NAME`) registrations from the Redis `all` hash and exits.
- A worker that dies unexpectedly is restarted by the master.
- `npm run doc` generates JSDoc into `docs/js` (dev dependency, output is not committed).

## Running with Docker

```sh
docker build -t socket-server .
docker run --rm -p 8000:8000 -e REDIS_HOST=redis -e APP_NAME=Server1 socket-server
```

The image runs `node server.js` as the non-root `node` user, exposes port 8000 and has a `HEALTHCHECK` on `/health`.
Give each container its own `APP_NAME` when several socket servers share the same Redis.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `HTTP_PORT` | `8000` | HTTP / socket.io port (shared by all workers) |
| `WORKERS` | CPU count | Number of worker processes (`1` is fine) |
| `APP_NAME` | `SERVER 1` | Name of this socket server instance; prefix of its registrations in the `all` hash, must be unique per instance |
| `APP_HOST` | `127.0.0.1` | Public host of this instance (informational, the server binds all interfaces) |
| `SHOULD_UPDATE_AND_EMIT` | `1` | `1` relays game server events to the clients; `0` only relays credits updates |
| `REDIS_HOST` | `127.0.0.1` | Redis for the store, the socket.io adapter and the registration channels |
| `REDIS_PORT` | `6379` | |
| `REDIS_PASSWORD` | _(empty)_ | Empty means no `AUTH` |
| `GAME_SERVER_REDIS_HOST` | `REDIS_HOST` | Redis the game servers publish `game-servers` on |
| `GAME_SERVER_REDIS_PORT` | `REDIS_PORT` | |
| `GAME_SERVER_REDIS_PASSWORD` | `REDIS_PASSWORD` | Set to empty to disable `AUTH` for this connection only |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Time the master waits for workers to exit before killing them |

## Client Emitters

### 'init( { userid, tableid } )'

Triggers the server to look for current round datas.

### 'jointable( tableid, [ callback ] )'

Triggers the server to have the *'current client's connected socket'* get registered to a room.

## Client Listeners

#### Event: 'swipecard'

Emitted when a card or dealer card is swiped / scanned.

#### Event: 'command'

Emitted when dealer presses the command actions _ex: numpad (6) to stop timer_.

#### Event: 'newround'
	
Emitted during the start of a new round.

#### Event: 'displayresults'

Emitted during the dealer displays the result of every round.

#### Event: 'activerounddatas'

Emitted as a response after emitting the *'init'* event.

#### Event: 'dealerchange'

Emitted during a dealer change

## Contributing

1. Fork it
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull/Merge Request