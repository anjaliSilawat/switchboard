# Switchboard

A shared team inbox. Customer messages arrive as Pigeon webhooks. Support agents sign in through the IdP, see conversations update live, claim a conversation, reply through Pigeon and see each reply's status (queued, sent, delivered or failed).

Stack: Node 22 + TypeScript (Express, `ws`), MongoDB, Redis, React (Vite). Both live under `scaffold/`.

## Run from a clean clone

Requirements: Node 22 or newer, and Docker.

```bash
npm run up                 # MongoDB, Redis, Pigeon, IdP (Docker)
npm run doctor             # every port should PASS
npm run scaffold:install   # server + web dependencies
npm run app                # builds the React app and serves everything on http://localhost:4000
```

Open **http://localhost:4000** and click **Sign in**. The IdP lists its test users (for example Ben in `ws_acme`, or Eli in both workspaces). The server serves the built React app itself, so there is one origin and nothing else needs a free port.

For UI work with hot reload: `npm run scaffold:server` and `npm run scaffold:web` (Vite on 5173; after login the server sends you to `WEB_ORIGIN`, which is 5173 by default. If 5173 is taken, use `WEB_PORT=5174 npm run scaffold:web` and set `WEB_ORIGIN=http://localhost:5174`). Delete `scaffold/web/dist` while using Vite, or login returns you to :4000.

All configuration comes from the environment (see `.env.example`). The defaults match the harness, so no `.env` file is needed.

## Check and tests

```bash
npm run check:full                 # stop your dev server first: it starts its own and wipes data
npm --prefix scaffold/server test  # unit/integration tests (uses db switchboard_test)
```

## Layout (`scaffold/server/src`)

| File | What it does |
| --- | --- |
| `index.ts` | Routes: webhook, `/__grader/*`, `/auth/*`, `/api/*`, health and boot |
| `webhook.ts` | Signature and timestamp check on the raw body, idempotent store, forward-only status |
| `outbox.ts` | Reply outbox in MongoDB, leased worker in every copy, Redis token bucket and Retry-After cool-off per workspace |
| `inbox.ts` | Atomic claim, list (keyset pagination), thread, snapshot, reset |
| `realtime.ts` | `seq` per workspace (Redis INCR), frames stored in MongoDB, Redis pub/sub between copies, replay with `after=` |
| `auth.ts` | OIDC code flow + PKCE; login state and sessions in Redis (httpOnly cookie) |
| `store.ts` | Collections, indexes and deterministic ids |

See `DECISIONS.md` for what was built, what was cut and what is still wrong.
