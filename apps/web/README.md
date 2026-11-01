# @paperbrew/web

Frontend: website and web app (Articles page, magazine builder, print/PDF output). Vite + React + TypeScript.
Screens are in the design canvas: https://claude.ai/artifact/LUnL7nbUXKMJFVzznBP4eC

```bash
npm run dev:web      # from the repo root; http://localhost:5173
```

In dev, requests to `/api/*` are proxied to the API on :8787 with the `/api` prefix stripped
(`/api/health` → `localhost:8787/health`). Run `npm run dev` alongside it.
