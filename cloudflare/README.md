# AskPool on Cloudflare

Live: <https://askpool.louis-zhou.workers.dev>

A port of the Java/PostgreSQL backend to one Cloudflare Worker with a D1 database. The Worker answers `/api/*` with the same contract as [docs/API.md](../docs/API.md) and serves the built React frontend (`../frontend/dist`) for everything else. Like the thomas-hub deployment, each browser gets a signed guest cookie (no sign-in), and questions go through the bundled sensitive-word list (`src/blocked-words.txt`, copied from the backend).

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run build
npm run migrate:local
npm run dev   # http://localhost:8791
```

## Deploy

First time only: `npx wrangler d1 create askpool` (put the id in `wrangler.toml`), `npm run migrate`, and set a stable random secret with `npx wrangler secret put GUEST_IDENTITY_SECRET`.

Then, after every change:

```bash
npm run deploy
```

New schema changes go in `migrations/` as the next numbered file; apply them with `npm run migrate`.
