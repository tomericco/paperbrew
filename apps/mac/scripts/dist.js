// `npm run dist`: checks PAPERBREW_API_URL, builds, then packages the universal .dmg with electron-builder.
// Written in Node (not shell) so the env handling works in any shell.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env };
// Without a named signing identity the app is only ad-hoc signed ("-"): never let electron-builder go looking in the
// keychain, and still seal the bundle so Apple Silicon Macs accept it (right-click > Open the first time).
const args = ['electron-builder', '--mac', '--universal'];
if (!env.CSC_NAME) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  // Hardened runtime + ad-hoc signing blocks loading Electron's own libraries, so it stays off until a real identity.
  args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);
}

run(process.execPath, [path.join(__dirname, 'require-api-url.js')]);
run('npm', ['run', 'build']);
run('npx', args);
