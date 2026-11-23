# @paperbrew/mac

The Paperbrew menu-bar app: pairs with your Paperbrew account and prints queued issues on this Mac.

## PAPERBREW_API_URL

The app needs to know which Paperbrew it talks to when someone types a code into **Paste code…** (a pairing link
carries its own address, a typed code does not). The address is fixed at build time:

- `npm run build` writes `dist/defaults.json` with `{ "api": "<origin>" }`, taken from the `PAPERBREW_API_URL`
  environment variable, or `http://localhost:5173` when it is not set (local development).
- The value must be `https://...` (or `http://localhost...`). Anything else fails the build.
- `npm run dist` (and `npm run dist:mac` from the repo root) refuses to run unless `PAPERBREW_API_URL` is an `https`
  URL, so a shipped `.dmg` can never carry the localhost default:

  ```
  PAPERBREW_API_URL=https://paperbrew.example npm run dist:mac
  ```

At runtime, **Paste code…** uses the origin saved by an earlier pairing, else this built-in default.
