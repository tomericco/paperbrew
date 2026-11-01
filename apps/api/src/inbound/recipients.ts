/**
 * Pull mailbox tokens out of the recipient list.
 * "K7F3Q9+travel@save.example.com" -> "k7f3q9" (plus-tags are ignored for now).
 */
export function addressTokens(recipients: string[], inboundDomain: string): string[] {
  const domain = inboundDomain.toLowerCase();
  const tokens = new Set<string>();
  for (const r of recipients) {
    const at = r.lastIndexOf('@');
    if (at < 1 || r.slice(at + 1).toLowerCase() !== domain) continue;
    const local = r.slice(0, at).toLowerCase().split('+')[0];
    if (/^[a-z0-9]{6,32}$/.test(local)) tokens.add(local);
  }
  return [...tokens];
}
