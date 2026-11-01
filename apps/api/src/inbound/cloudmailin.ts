import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InboundEmail } from './types.js';

// CloudMailin "JSON (Normalized)" POST format: https://docs.cloudmailin.com/http_post_formats/json_normalized/
// Header keys arrive lowercased with underscores (message_id, list_unsubscribe); a header that occurs more
// than once arrives as an array. Lookups below also accept Message-ID / message-id in case that changes.
const CloudmailinInbound = z
  .object({
    envelope: z
      .object({
        to: z.string().nullish(),
        recipients: z.array(z.string()).nullish(),
        from: z.string().nullish(),
      })
      .passthrough(),
    headers: z.record(z.string(), z.unknown()).nullish(),
    plain: z.string().nullish(),
    html: z.string().nullish(),
  })
  .passthrough();

const headerKey = (key: string) => key.trim().toLowerCase().replace(/-/g, '_');

/** Bare addresses from header values like `Name <a@x>, "Last, First" <b@y>, c@z`. */
function addresses(value: string): string[] {
  return (value.match(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g) ?? []).map((a) => a.trim().toLowerCase());
}

export function normalizeCloudmailin(body: unknown): InboundEmail {
  const p = CloudmailinInbound.parse(body);

  const headers = new Map<string, string[]>();
  for (const [key, value] of Object.entries(p.headers ?? {})) {
    const values = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
    if (values.length) headers.set(headerKey(key), [...(headers.get(headerKey(key)) ?? []), ...values]);
  }
  const header = (name: string) => headers.get(headerKey(name))?.[0] ?? null;
  const allOf = (name: string) => headers.get(headerKey(name)) ?? [];

  const envelopeFrom = (p.envelope.from ?? '').trim();
  const subject = header('subject') ?? '';
  const date = header('date');
  const text = p.plain ?? '';
  const html = p.html ?? '';
  const messageId = header('message_id');

  const recipients = [
    ...(p.envelope.recipients ?? []),
    p.envelope.to ?? '',
    ...allOf('to'),
    ...allOf('cc'),
  ].flatMap(addresses);

  // CloudMailin retries on 5xx, so the id must be the same on every delivery of one email.
  const providerMessageId =
    messageId ??
    createHash('sha256')
      .update(`${envelopeFrom}\n${date ?? ''}\n${subject}\n${text || html}`)
      .digest('hex');

  return {
    provider: 'cloudmailin',
    providerMessageId,
    messageId,
    from: addresses(envelopeFrom)[0] ?? addresses(header('from') ?? '')[0] ?? '',
    recipients: [...new Set(recipients)],
    subject,
    date,
    text,
    html,
    listUnsubscribe: header('list_unsubscribe'),
  };
}
