import { describe, expect, it } from 'vitest';
import { normalizePostmark } from '../src/inbound/postmark.js';
import { addressTokens } from '../src/inbound/recipients.js';
import { cleanSubject, planEmail, splitForward } from '../src/inbound/plan.js';
import { extractNewsletter } from '../src/extract/readable.js';
import { forwardedNewsletterFixture, paragraphs } from './helpers.js';

describe('addressTokens', () => {
  it('finds tokens on the inbound domain only, ignoring plus tags and case', () => {
    expect(
      addressTokens(['K7F3Q9X2+travel@SAVE.example.com', 'friend@gmail.com', 'ab@save.example.com'], 'save.example.com'),
    ).toEqual(['k7f3q9x2']);
  });
});

describe('splitForward', () => {
  it('separates the note, the original sender and subject (Gmail)', () => {
    const s = splitForward('Read this.\n\n---------- Forwarded message ---------\nFrom: A <a@x.com>\nDate: today\nSubject: Fwd: Hello\nTo: me\n\nBody here.');
    expect(s.note).toBe('Read this.');
    expect(s.forwarded).toBe('Body here.');
    expect(s.original).toEqual({ from: 'A <a@x.com>', subject: 'Fwd: Hello' });
  });
  it('handles Apple Mail', () => {
    const s = splitForward('Begin forwarded message:\n\nFrom: B <b@y.com>\nSubject: Weekly\nDate: x\n\nHi all.');
    expect(s.forwarded).toBe('Hi all.');
    expect(s.original?.subject).toBe('Weekly');
  });
});

describe('cleanSubject', () => {
  it('removes stacked forward prefixes', () => {
    expect(cleanSubject('Fwd: FW: Re-think: reading')).toBe('Re-think: reading');
  });
});

describe('planEmail', () => {
  it('saves a long forwarded newsletter as an article, titled from the original subject', () => {
    const email = normalizePostmark(forwardedNewsletterFixture());
    expect(email.from).toBe('tomer@example.com');
    const plan = planEmail(email);
    expect(plan.reason).toBe('forwarded-newsletter');
    expect(plan.urls).toEqual([]);
    expect(plan.newsletter?.title).toBe('The case for slow reading');
    expect(plan.newsletter?.author).toBe('Slow Notes');
  });

  it('saves links from a short email the user wrote', () => {
    const plan = planEmail({
      from: 'me@example.com',
      subject: 'for the flight',
      text: 'https://paulgraham.com/greatwork.html\nhttps://mcfunley.com/choose-boring-technology',
      html: '',
    });
    expect(plan.reason).toBe('links');
    expect(plan.urls).toHaveLength(2);
    expect(plan.newsletter).toBeNull();
  });

  it('saves links from a short forward ("thought you would like this")', () => {
    const plan = planEmail({
      from: 'me@example.com',
      subject: 'Fwd: look',
      text: 'FYI\n\n---------- Forwarded message ---------\nFrom: Dana <d@x.com>\nSubject: look\n\nThought you would like this https://example.org/essays/attention',
      html: '',
    });
    expect(plan.urls).toEqual(['https://example.org/essays/attention']);
    expect(plan.newsletter).toBeNull();
  });

  it('keeps a newsletter sent straight to the Paperbrew address', () => {
    const plan = planEmail({
      from: 'Weekly Essays <hello@weekly.example>',
      subject: 'Issue 42: On attention',
      text: paragraphs(10).join('\n\n'),
      html: '',
      listUnsubscribe: '<https://weekly.example/u/1>',
    });
    expect(plan.reason).toBe('direct-newsletter');
    expect(plan.newsletter?.title).toBe('Issue 42: On attention');
  });

  it('saves nothing from an empty email', () => {
    expect(planEmail({ from: 'a@b.c', subject: 'hi', text: 'hello', html: '' }).reason).toBe('nothing-to-save');
  });
});

describe('extractNewsletter', () => {
  it('drops the Gmail forward header, layout tables and the unsubscribe link', () => {
    const email = normalizePostmark(forwardedNewsletterFixture());
    const plan = planEmail(email);
    const a = extractNewsletter(plan.newsletter!);
    expect(a.title).toBe('The case for slow reading');
    expect(a.contentHtml).not.toMatch(/Forwarded message/);
    expect(a.contentHtml).not.toMatch(/<script|<style|class=|<t(able|body|r|d)\b/);
    expect(a.contentHtml).not.toMatch(/Unsubscribe/);
    expect(a.wordCount).toBeGreaterThan(300);
    expect(a.readingMinutes).toBeGreaterThanOrEqual(2);
  });
});
