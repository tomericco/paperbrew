// Writes dist/defaults.json = { "api": <origin> }: the Paperbrew origin the Paste code window uses on a fresh
// install. From env PAPERBREW_API_URL, else http://localhost:5173 (dev). Run after tsc (uses dist/settings.js so the
// validation rule is the same one the app applies at runtime). An invalid value fails the build.
const fs = require('node:fs');
const path = require('node:path');
const { safeApiOrigin } = require('../dist/settings');

const raw = process.env.PAPERBREW_API_URL || 'http://localhost:5173';
const api = safeApiOrigin(raw);
if (!api) {
  console.error(`PAPERBREW_API_URL must be an https URL (or http://localhost...), got: ${raw}`);
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, '..', 'dist', 'defaults.json'), JSON.stringify({ api }, null, 2) + '\n');
console.log(`dist/defaults.json: api = ${api}`);
