// Guard for `npm run dist`: a shipped build must not carry the localhost default.
const raw = process.env.PAPERBREW_API_URL;
let ok = false;
try {
  const u = new URL(raw || '');
  ok = u.protocol === 'https:' && !u.username && !u.password;
} catch {}
if (!ok) {
  console.error(
    'npm run dist needs PAPERBREW_API_URL set to the https address of Paperbrew, for example:\n' +
      '  PAPERBREW_API_URL=https://paperbrew.example npm run dist:mac\n' +
      `Got: ${raw ? raw : '(not set)'}`,
  );
  process.exit(1);
}
