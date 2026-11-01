# Paperbrew

Turns the articles people save from Hacker News, blogs and newsletters into a magazine they print at home.

Live: web https://paperbrew-web.vercel.app · API https://paperbrew-api.vercel.app (Vercel, deploys on every push to `main`; database on Supabase).

npm workspaces monorepo:

```
apps/api    @paperbrew/api  backend: email capture, article fetching, job worker (Hono + Postgres)
apps/web    @paperbrew/web  frontend: website + web app (Vite + React)
packages/   shared code (types, API client) when there is some
```

## Commands (from the repo root)

```bash
npm install          # one install for every workspace
npm run dev          # API on :8787
npm run dev:web      # web app on :5173 (proxies /api/* to the API)
npm run worker       # job worker
npm run db:migrate   # apply apps/api/src/db/schema.sql
npm test             # tests in every workspace
npm run typecheck    # typecheck every workspace
```

Run one workspace's script with `npm run <script> -w @paperbrew/api`. Add a dependency with `npm install <pkg> -w @paperbrew/web`.

See [apps/api/README.md](apps/api/README.md) for the backend flow, Postmark setup and security notes.
