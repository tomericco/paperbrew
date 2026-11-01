import { z } from 'zod';
import type { InboundEmail } from './types.js';

// Postmark inbound webhook JSON. Only the fields we use; everything else passes through.
const Address = z.object({ Email: z.string(), Name: z.string().optional() });

const PostmarkInbound = z
  .object({
    MessageID: z.string().min(1),
    From: z.string().default(''),
    FromFull: Address.optional(),
    ToFull: z.array(Address).default([]),
    CcFull: z.array(Address).default([]),
    BccFull: z.array(Address).default([]),
    OriginalRecipient: z.string().default(''),
    Subject: z.string().default(''),
    Date: z.string().optional(),
    TextBody: z.string().default(''),
    HtmlBody: z.string().default(''),
    Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).default([]),
  })
  .passthrough();

export function normalizePostmark(body: unknown): InboundEmail {
  const p = PostmarkInbound.parse(body);
  const header = (name: string) =>
    p.Headers.find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value ?? null;

  const recipients = [
    ...p.ToFull.map((a) => a.Email),
    ...p.CcFull.map((a) => a.Email),
    ...p.BccFull.map((a) => a.Email),
    p.OriginalRecipient,
  ]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    provider: 'postmark',
    providerMessageId: p.MessageID,
    messageId: header('Message-ID'),
    from: (p.FromFull?.Email ?? p.From).trim().toLowerCase(),
    recipients: [...new Set(recipients)],
    subject: p.Subject,
    date: p.Date ?? null,
    text: p.TextBody,
    html: p.HtmlBody,
    listUnsubscribe: header('List-Unsubscribe'),
  };
}
