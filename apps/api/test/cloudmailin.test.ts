import { describe, expect, it } from 'vitest';
import { normalizeCloudmailin } from '../src/inbound/cloudmailin.js';
import { addressTokens } from '../src/inbound/address.js';
import { planEmail } from '../src/inbound/plan.js';
import { cloudmailinForwardedFixture } from './helpers.js';

const ADDRESS = '4fcb639be7306607cef6+amber-otter-lantern@cloudmailin.net';
const TEMPLATE = '4fcb639be7306607cef6+{token}@cloudmailin.net';

/** The fixture with its headers replaced, so each test controls the header keys exactly. */
function withHeaders(headers: Record<string, unknown>) {
  return { ...cloudmailinForwardedFixture(), headers };
}

describe('normalizeCloudmailin', () => {
  it('maps a Gmail forward (JSON Normalized)', () => {
    const email = normalizeCloudmailin(cloudmailinForwardedFixture());
    expect(email.provider).toBe('cloudmailin');
    expect(email.recipients).toContain(ADDRESS);
    expect(addressTokens(email.recipients, TEMPLATE)).toEqual(['amber-otter-lantern']);
    expect(email.from).toBe('tomer@example.com');
    expect(email.subject).toBe('Fwd: The case for slow reading');
    expect(email.date).toBe('Mon, 2 Nov 2026 08:14:00 +0200');
    expect(email.text).toMatch(/^Save this one for the flight\./);
    expect(email.html).toMatch(/^<div dir="ltr">/);
    expect(email.messageId).toBe('<CAF=abc@mail.gmail.com>');
    expect(email.providerMessageId).toBe('<CAF=abc@mail.gmail.com>');
    expect(email.listUnsubscribe).toBeNull();
  });

  it('collects envelope and To/Cc header addresses, lowercased and deduped', () => {
    const body = cloudmailinForwardedFixture();
    body.envelope.to = '4FCB639BE7306607CEF6+Amber-Otter-Lantern@CloudMailin.net';
    body.envelope.recipients = [ADDRESS, 'other@cloudmailin.net'];
    body.headers.to = 'Me <me@example.com>, "Paperbrew, mine" <4fcb639be7306607cef6+amber-otter-lantern@cloudmailin.net>';
    body.headers.cc = ['Friend <Friend@Example.com>', 'plain@example.com'];
    const email = normalizeCloudmailin(body);
    expect(email.recipients.sort()).toEqual(
      [ADDRESS, 'other@cloudmailin.net', 'me@example.com', 'friend@example.com', 'plain@example.com'].sort(),
    );
  });

  it.each(['Message-ID', 'message-id', 'message_id', 'MESSAGE_ID'])('reads the %s header key', (key) => {
    const email = normalizeCloudmailin(withHeaders({ [key]: '<id-1@x>', subject: 's' }));
    expect(email.messageId).toBe('<id-1@x>');
    expect(email.providerMessageId).toBe('<id-1@x>');
  });

  it('takes the first value of a header sent as an array', () => {
    const email = normalizeCloudmailin(
      withHeaders({ message_id: ['<first@x>', '<second@x>'], Subject: ['Hello', 'Again'], 'List-Unsubscribe': ['<https://u.example/1>'] }),
    );
    expect(email.messageId).toBe('<first@x>');
    expect(email.subject).toBe('Hello');
    expect(email.listUnsubscribe).toBe('<https://u.example/1>');
  });

  it('reads List-Unsubscribe in normalized spelling', () => {
    const email = normalizeCloudmailin(withHeaders({ list_unsubscribe: '<mailto:u@x>' }));
    expect(email.listUnsubscribe).toBe('<mailto:u@x>');
  });

  it('falls back to the From header when the envelope has no sender', () => {
    const body = cloudmailinForwardedFixture();
    body.envelope.from = '';
    body.headers.from = 'Someone Else <Someone@Example.org>';
    expect(normalizeCloudmailin(body).from).toBe('someone@example.org');
  });

  it('derives a stable sha256 id when Message-ID is missing', () => {
    const body = cloudmailinForwardedFixture();
    delete body.headers.message_id;
    const a = normalizeCloudmailin(body);
    const b = normalizeCloudmailin(structuredClone(body));
    expect(a.messageId).toBeNull();
    expect(a.providerMessageId).toMatch(/^[0-9a-f]{64}$/);
    expect(b.providerMessageId).toBe(a.providerMessageId);

    const other = structuredClone(body);
    other.headers.subject = 'Something else';
    expect(normalizeCloudmailin(other).providerMessageId).not.toBe(a.providerMessageId);
  });

  it('throws on a body without an envelope', () => {
    const body = cloudmailinForwardedFixture();
    delete body.envelope;
    expect(() => normalizeCloudmailin(body)).toThrow();
    expect(() => normalizeCloudmailin('not json')).toThrow();
  });

  it('plans the forward like the Postmark one: a forwarded newsletter saved as an article', () => {
    const plan = planEmail(normalizeCloudmailin(cloudmailinForwardedFixture()));
    expect(plan.reason).toBe('forwarded-newsletter');
    expect(plan.urls).toEqual([]);
    expect(plan.newsletter?.title).toBe('The case for slow reading');
    expect(plan.newsletter?.author).toBe('Slow Notes');
  });
});
