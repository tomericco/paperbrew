import { describe, expect, it } from 'vitest';
import { passesBodyRules, passesMetadataRules, senderEmail } from '../src/gmail/rules.js';

const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');

describe('senderEmail', () => {
  it('lowercases the address out of a display-name header', () => {
    expect(senderEmail('The Daily <News@Example.COM>')).toBe('news@example.com');
  });

  it('accepts a bare address', () => {
    expect(senderEmail('  Bob@Example.com ')).toBe('bob@example.com');
  });
});

describe('passesMetadataRules', () => {
  const blocked = new Set(['spam@example.com']);

  it('rejects mail with neither list header', () => {
    expect(passesMetadataRules({ listUnsubscribe: null, listId: null, from: 'a@b.com' }, blocked)).toEqual({
      ok: false,
      reason: 'not-a-list',
    });
  });

  it('rejects a blocked sender, case-insensitively', () => {
    const meta = { listUnsubscribe: '<mailto:u@x.com>', listId: null, from: 'Spam <SPAM@Example.com>' };
    expect(passesMetadataRules(meta, blocked)).toEqual({ ok: false, reason: 'blocked-sender' });
  });

  it('accepts a list mail from an unblocked sender', () => {
    expect(passesMetadataRules({ listUnsubscribe: null, listId: '<l.x.com>', from: 'a@b.com' }, blocked)).toEqual({
      ok: true,
      reason: 'ok',
    });
  });
});

describe('passesBodyRules', () => {
  it('rejects 249 words as too short', () => {
    const text = words(249);
    expect(passesBodyRules({ html: `<p>${text}</p>`, text })).toEqual({ ok: false, reason: 'too-short' });
  });

  it('rejects mostly-link bodies', () => {
    const text = words(300);
    const html = `<p>${words(180)} <a href="https://x.com">${words(120)}</a></p>`;
    expect(passesBodyRules({ html, text })).toEqual({ ok: false, reason: 'mostly-links' });
  });

  it('accepts prose', () => {
    const text = words(300);
    expect(passesBodyRules({ html: `<p>${text}</p>`, text })).toEqual({ ok: true, reason: 'ok' });
  });

  it('treats an empty html as all prose', () => {
    expect(passesBodyRules({ html: '', text: words(300) })).toEqual({ ok: true, reason: 'ok' });
  });

  it('ignores tags nested inside anchor text when counting words', () => {
    const text = words(300);
    const html = `<p>${words(200)} <A HREF="x"><span>${words(60)}</span></A></p>`;
    expect(passesBodyRules({ html, text }).ok).toBe(true);
  });

  it('stays linear on 500 KB of unclosed anchors', () => {
    const html = '<a '.repeat(150000);
    const start = performance.now();
    passesBodyRules({ html, text: words(300) });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('stays linear on 500 KB of text', () => {
    const text = 'lorem ipsum dolor '.repeat(28000);
    const html = `<p>${text}</p><a href="x">${'<'.repeat(100000)}</a>`;
    const start = performance.now();
    passesBodyRules({ html, text });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
