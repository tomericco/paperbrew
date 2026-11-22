import { describe, expect, it } from 'vitest';
import type { GmailMessage, GmailPart } from '../src/gmail/client.js';
import { decodeBody, header } from '../src/gmail/mime.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const part = (mimeType: string, data: string, extra: Partial<GmailPart> = {}): GmailPart => ({
  mimeType,
  body: { data: b64(data) },
  ...extra,
});

describe('decodeBody', () => {
  it('returns a single text/plain part as text only', () => {
    expect(decodeBody(part('text/plain', 'Hello there'))).toEqual({ html: '', text: 'Hello there' });
  });

  it('returns both parts of multipart/alternative', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/alternative',
      parts: [part('text/plain', 'plain body'), part('text/html', '<p>html body</p>')],
    };
    expect(decodeBody(payload)).toEqual({ html: '<p>html body</p>', text: 'plain body' });
  });

  it('handles nested alternative inside mixed and ignores attachments', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [part('text/plain', 'plain body'), part('text/html', '<p>html body</p>')],
        },
        { mimeType: 'application/pdf', filename: 'x.pdf', body: { data: b64('%PDF-1.4'), size: 8 } },
      ],
    };
    expect(decodeBody(payload)).toEqual({ html: '<p>html body</p>', text: 'plain body' });
  });

  it('ignores text parts that are attachments', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [part('text/plain', 'attached notes', { filename: 'notes.txt' }), part('text/plain', 'real body')],
    };
    expect(decodeBody(payload).text).toBe('real body');
  });

  it('html-only derives text', () => {
    const out = decodeBody(part('text/html', '<p>Hello <b>world</b></p><style>p{}</style>'));
    expect(out.html).toBe('<p>Hello <b>world</b></p><style>p{}</style>');
    expect(out.text).toBe('Hello world');
  });

  it('derives text with block newlines, entities and collapsed whitespace', () => {
    const html =
      '<html><head><title>T</title></head><body><script>var a=1;</script>' +
      '<h1>Title</h1><p>A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&nbsp;z</p>' +
      '<div>one</div><div>two</div><br><br><br><br><ul><li>x</li></ul>   spaced    out</body></html>';
    expect(decodeBody(part('text/html', html)).text).toBe(
      'Title\nA & B <c> "d" \'e\' A z\none\ntwo\n\nx\nspaced out',
    );
  });

  it('does not crash on missing body, parts or data', () => {
    expect(decodeBody({ mimeType: 'multipart/mixed' })).toEqual({ html: '', text: '' });
    expect(decodeBody({ mimeType: 'text/plain' })).toEqual({ html: '', text: '' });
    expect(decodeBody({ mimeType: 'text/html', body: {} })).toEqual({ html: '', text: '' });
  });
});

describe('header', () => {
  const msg: GmailMessage = {
    id: '1',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Hi' },
        { name: 'List-Unsubscribe', value: '<mailto:u@example.com>' },
      ],
    },
  };

  it('finds a header case-insensitively', () => {
    expect(header(msg, 'list-unsubscribe')).toBe('<mailto:u@example.com>');
    expect(header(msg, 'SUBJECT')).toBe('Hi');
  });

  it('returns null when absent or when headers are missing', () => {
    expect(header(msg, 'x-nope')).toBeNull();
    expect(header({ id: '2', payload: { mimeType: 'text/plain' } }, 'subject')).toBeNull();
  });
});
