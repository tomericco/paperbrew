import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lpArgs, type Layout } from './lp';

const TEMP_PREFIX = 'paperbrew-';

/** `lp`, never through a shell. Rejects with lp's stderr so the failure shows up in Paperbrew settings. */
export function print(file: string, layout: Layout, printer: string | null): Promise<void> {
  const args = lpArgs(file, layout, printer);
  return new Promise((resolve, reject) => {
    execFile('lp', args, { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const text = String(stderr ?? '').trim();
      reject(new Error(text || err.message));
    });
  });
}

/** Output of `lpstat -p -d`, or '' when CUPS has no printers or lpstat fails. */
export function lpstat(): Promise<string> {
  return new Promise((resolve) => {
    execFile('lpstat', ['-p', '-d'], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/** Writes the PDF into a fresh private directory under the OS temp dir (mkdtemp: unpredictable name, mode 0700). */
export async function writeTemp(bytes: Uint8Array, base: string = tmpdir()): Promise<string> {
  const dir = await mkdtemp(path.join(base, TEMP_PREFIX));
  const file = path.join(dir, 'issue.pdf');
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

/** Removes the whole temp directory writeTemp created. Refuses anything that is not one of ours. */
export async function removeTemp(file: string): Promise<void> {
  const dir = path.dirname(file);
  if (!path.basename(dir).startsWith(TEMP_PREFIX)) return;
  await rm(dir, { recursive: true, force: true });
}
