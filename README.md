# Casino Diko: Backend

Backend for live-dealer table games: **Baccarat**, **Dragon-Tiger** and **Poker** (casino hold'em).

```
dealer page ──socket.io──▶ game-server ──redis `game-servers`──▶ socket-server ──socket.io──▶ players (web)
                              │                                       │
                           MongoDB ◀──────────── bets ──────────── web (Next.js)
```

| Part | Where | What it does |
|---|---|---|
| **game-server** | `game-server/` | One process hosting every game, each on its own port (8007 baccarat, 8008 dragon-tiger, 8009 poker). Dealer pages (card scanners) connect to it. Stores rounds, bets and road maps in MongoDB, settles bets, publishes every game event to Redis. |
| **socket-server** | `socket-server/` | Clustered socket.io gateway relaying game events to players in per-table namespaces (`/<Game>/<table>`, `/all`, `/managers`). See [socket-server/readme.md](socket-server/readme.md). |
| **admin** | `admin/` | Next.js back-office: add players, add or deduct credits, every player's transactions (credit adjustments and game bets). See [Admin](#admin). |
| **web** | separate repo [casino-diko/web](https://github.com/casino-diko/web) | Next.js player front-end: lobby at `/`, games at `/baccarat`, `/dragon-tiger`, `/poker`. Places bets into the same MongoDB. |
| MongoDB 7, Redis 7 | Docker | MongoDB runs as a single-node replica set, because bet settlement uses transactions. |

## Requirements

- **Docker** 24+ with **Docker Compose** v2 (`docker compose`)
- **git**
- For the dealer simulator and for local development: **Node.js 22** and npm 10
- About 3 GB of free disk space for the images

## Installation

Clone both repositories **next to each other**: the compose file builds the front-end from `../web`.

```sh
mkdir casino-diko && cd casino-diko
git clone git@github.com:casino-diko/backend.git
git clone git@github.com:casino-diko/web.git
cd backend
```

Create the configuration:

```sh
cp .env.example .env
```

Edit `.env`. For a local setup, set at least:

```sh
SESSION_SECRET=<output of: openssl rand -hex 32>   # required, the front-end refuses to start without it
DEV_LOGIN=true                                      # /login page to pick a demo player (development only)

# optional: fake live video for every table
COMPOSE_PROFILES=dev
HLS_URL_TEMPLATE=http://localhost:8080/hls/{app}-{table}.m3u8
```

If `web` is checked out somewhere else, set `GAME_FRONT_DIR=/path/to/web`.

## Run

```sh
docker compose up -d --build      # first build takes a few minutes
docker compose run --rm seed      # demo data: tables, dealers, players (only fills an empty database)
docker compose ps                 # all services should be "healthy"
```

Open **http://localhost:3000/login**, pick a demo player and open a table from the lobby.

| Service | URL / port | Health check |
|---|---|---|
| web (front-end) | http://localhost:3000 | `/health` |
| socket-server | http://localhost:8000 | `/health` |
| game-server | 8007 baccarat, 8008 dragon-tiger, 8009 poker (dealer pages) | `/health` on each port |
| admin (back-office) | http://localhost:3001 (this machine only) | `/health` |
| hls-dev | http://localhost:8080 (only with `COMPOSE_PROFILES=dev`) | `/health` |
| mongo, redis | internal only | |

### Admin

The back-office at **http://localhost:3001**. Set its login in `.env` first, then `docker compose up -d --build admin`:

```sh
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<a strong password>
ADMIN_SESSION_SECRET=<output of: openssl rand -hex 32>
```

- **Players**: search by login id, name or `#id`, filter by vendor.
- **Add player**: vendor, login id (unique per vendor), display name, optional password (stored as an scrypt hash), currency, type, optional initial credits.
- **Player page**: the balance, a form to add or deduct credits with a note, and the player's transactions: credit adjustments and bets from all three games (stake, payout, net; open rounds show the stake only).
- **Transactions**: every credit adjustment, filterable by player and type.

Credits only exist for **transfer** vendors (balance in `users.money`). Seamless vendors hold the balance in their own wallet API, so their players can be created but not credited. Each adjustment is written to `nihtan_api.transactions` in the same MongoDB transaction as the balance change (who, amount, balance before and after); a resubmitted form is ignored. Deductions can't take a balance below 0.

The port is bound to `127.0.0.1`. To reach it from elsewhere set `ADMIN_BIND=0.0.0.0`, but only behind https with `ADMIN_SESSION_SECURE=true`.

Local development: `cd admin && cp .env.example .env && npm install && npm run dev` (needs MongoDB reachable at `MONGO_URI`); `npm test` runs the validation tests.

### Play rounds without real dealers

The tables only move when a dealer plays. For testing, run the dealer simulator. It plays endless rounds on every table: betting countdown, cards, results.

```sh
cd game-server
npm install
npm run dealer                    # Ctrl+C to stop
BET_SECONDS=30 npm run dealer     # longer betting windows (also STREET_SECONDS for poker, RESULT_SECONDS)
```

### Demo data

| | |
|---|---|
| Players 1, 2 | vendor with **transfer** wallet: the balance lives in MongoDB and changes on every bet / payout |
| Player 3 | vendor with **seamless** wallet: the balance is held by the vendor API (`VENDOR_API_URL`); without one it reads 0 and bets are refused |
| Dealers | codes `D0001`–`D0003` (scan a code on the dealer page to change dealer) |
| Tables | 2 per game |

### Everyday commands

```sh
docker compose logs -f web game-server    # follow logs
docker compose restart game-server        # restart one service (restart the dealer simulator afterwards)
docker compose down                       # stop everything (data is kept)
docker compose down -v                    # stop and wipe the database
docker compose up -d --build web          # rebuild after changing the front-end
```

A player can only be logged in once: opening the same player in a second browser sends the first one to the "rejected" page.

## Develop locally (without Docker for the Node services)

Start MongoDB (as a replica set) and Redis:

```sh
docker run -d --name casino-mongo -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec casino-mongo mongosh --quiet --eval 'rs.initiate()'
docker run -d --name casino-redis -p 6379:6379 redis:7-alpine
```

game-server:

```sh
cd game-server
cp .env.example .env      # MONGO_URI, REDIS_*, GAMES, ports
npm install
npm run seed
npm start                 # or GAMES=baccarat npm start
```

socket-server:

```sh
cd socket-server
cp .env.example .env
npm install
npm start                 # http://localhost:8000
```

Front-end: see the README of the [web](https://github.com/casino-diko/web) repository.

## Tests

In `game-server/`:

```sh
npm test                                     # unit tests, no services needed
node --test test/poker.test.js               # one file
node scripts/smoke-baccarat.js               # dealer end-to-end run against a running game-server + MongoDB + Redis
SMOKE_SPAWN=0 node scripts/smoke-poker.js    # poker's smoke test starts its own server unless SMOKE_SPAWN=0
```

The smoke scripts connect to MongoDB and Redis directly and use the same environment variables as the server.

## Configuration

`.env` (read by `docker compose`):

| Variable | Default | |
|---|---|---|
| `SESSION_SECRET` | none, **required** | signs the players' session cookie (32+ characters) |
| `DEV_LOGIN` | `false` | `true` enables `/login` to pick any player. **Never in production.** |
| `SESSION_SECURE` | `false` | `true` when the site is served over https |
| `WEB_PORT` / `SOCKET_SERVER_PORT` | `3000` / `8000` | host ports |
| `BACCARAT_PORT` / `DRAGONTIGER_PORT` / `POKER_PORT` | `8007` / `8008` / `8009` | dealer page ports |
| `PUBLIC_SOCKET_URL` | `http://localhost:8000` | socket-server url **as seen from the players' browsers** |
| `REDIS_PASSWORD` | empty | protects Redis (used by every service) |
| `SOCKET_SERVER_WORKERS` | `2` | socket-server worker processes |
| `API_HISTORY_URL` | empty | round results are POSTed here (not sent when empty) |
| `VENDOR_API_URL` | empty | vendor API for seamless wallets |
| `HLS_URL_TEMPLATE` | empty | live video url per table, placeholders `{app}` `{game}` `{table}` `{table2}` `{quality}`; a table's `env_setting.hls` takes precedence |
| `COMPOSE_PROFILES` | empty | `dev` also starts the fake video streams (`hls-dev`) |
| `GAME_FRONT_DIR` | `../web` | where the front-end repository is checked out |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / empty | back-office login; the admin refuses logins until a password is set |
| `ADMIN_SESSION_SECRET` | empty | signs the admin session cookie (32+ characters), required to log in |
| `ADMIN_SESSION_SECURE` | `false` | `true` when the admin is served over https |
| `ADMIN_PORT` / `ADMIN_BIND` | `3001` / `127.0.0.1` | admin host port and the interface it listens on |

Each service also documents its own variables in its `.env.example` (`game-server/`, `socket-server/`).

## Going to production

- Set a strong `SESSION_SECRET`, keep `DEV_LOGIN=false`, set `SESSION_SECURE=true` behind https, and set a `REDIS_PASSWORD`.
- Players can't log in yet: only the development login exists. A vendor launch flow (signed redirect that creates the session) still has to be built.
- Point each table's video at your HLS CDN (`env_setting.hls` or `HLS_URL_TEMPLATE`). The CDN must send CORS headers.
- `PUBLIC_SOCKET_URL` must be the public URL of the socket-server.
- Run MongoDB as a proper replica set with backups instead of the single node of the compose file.

## Troubleshooting

| Problem | Fix |
|---|---|
| `required variable SESSION_SECRET is missing` | set `SESSION_SECRET` in `.env` |
| `web` build fails: path not found | clone the web repo next to this one, or set `GAME_FRONT_DIR` |
| Tables never change | run the dealer simulator (`cd game-server && npm run dealer`) |
| Lobby is empty | run `docker compose run --rm seed` |
| "Rejected" page | the same player is logged in somewhere else |
| No video, `[tg-video] no HLS stream configured` in the browser console | set `HLS_URL_TEMPLATE` (and `COMPOSE_PROFILES=dev` for the fake streams) |
| Video starts muted | browsers block autoplay with sound; it unmutes on the first click / tap |
