export type Printer = { name: string; isDefault: boolean };

/** Parses the output of `lpstat -p -d`. The default printer comes first; the rest keep their order. */
export function parsePrinters(lpstatOutput: string): Printer[] {
  const names: string[] = [];
  let def: string | null = null;
  for (const raw of lpstatOutput.split(/\r?\n/)) {
    const line = raw.trim();
    const p = /^printer\s+(\S+)\s+/.exec(line);
    if (p) {
      names.push(p[1]);
      continue;
    }
    const d = /^system default destination:\s*(\S+)\s*$/.exec(line);
    if (d) def = d[1];
  }
  const printers = names.map((name) => ({ name, isDefault: name === def }));
  return [...printers.filter((p) => p.isDefault), ...printers.filter((p) => !p.isDefault)];
}
