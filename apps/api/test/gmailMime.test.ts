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

const textOf = (html: string) => decodeBody(part('text/html', html)).text;

describe('html to text: linear time on hostile input', () => {
  const cases: [string, string, string][] = [
    ['many bare <', 'x' + '<'.repeat(500_000), 'x' + '<'.repeat(500_000)],
    ['many unclosed tag openers', 'x<a'.repeat(160_000), 'x<a'.repeat(160_000)],
    ['many unclosed <style>', 'x<style>'.repeat(70_000), 'x'],
    ['many unclosed <script>', 'x<script>'.repeat(60_000), 'x'],
    ['many unterminated comments', 'x<!--'.repeat(125_000), 'x'],
  ];
  it.each(cases)('%s finishes in under 300 ms', (_name, html, expected) => {
    const start = performance.now();
    const out = textOf(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(300);
    expect(out).toBe(expected);
  }, 60_000);

  it('keeps a bare < without a closing > as literal text', () => {
    expect(textOf('<p>a < b</p><p>c <d')).toBe('a < b\nc <d');
  });

  it('drops the rest of the input after an unclosed script or style', () => {
    expect(textOf('<p>keep</p><script>var a = 1; <p>gone</p>')).toBe('keep');
    expect(textOf('<p>keep</p><style>p{} <p>gone</p>')).toBe('keep');
  });
});

describe('html to text: entities', () => {
  it.each([
    ['&rsquo;', '’'],
    ['&lsquo;', '‘'],
    ['&ldquo;', '“'],
    ['&rdquo;', '”'],
    ['&mdash;', '—'],
    ['&ndash;', '–'],
    ['&hellip;', '…'],
    ['&copy;', '©'],
    ['&bull;', '•'],
    ['&middot;', '·'],
    ['&trade;', '™'],
    ['&reg;', '®'],
  ])('decodes %s', (entity, char) => {
    expect(textOf(`<p>a${entity}b</p>`)).toBe(`a${char}b`);
  });

  it('removes zero-width entities and characters', () => {
    expect(textOf('<p>a&zwnj;&zwj;b&#8203;c&#xFEFF;d⁠e</p>')).toBe('abcde');
  });

  it('does not double-decode', () => {
    expect(textOf('<p>&amp;lt;</p>')).toBe('&lt;');
  });

  it('leaves invalid or unknown entities literal', () => {
    expect(textOf('<p>&#99999999; &#xD800; &bogus; AT&T</p>')).toBe('&#99999999; &#xD800; &bogus; AT&T');
  });

  it('collapses nbsp and U+00A0 runs to a single space', () => {
    expect(textOf('<p>a&nbsp;&#160;&nbsp; b&zwnj;&nbsp;&zwnj;&nbsp;c</p>')).toBe('a b c');
  });
});

describe('html to text: comments and scripts', () => {
  it('removes comments, including ones containing >', () => {
    expect(textOf('<p>a<!-- x > y --> b</p>')).toBe('a b');
    expect(textOf('<!-- one --><p>a</p><!--\nmulti\nline\n--><p>b</p>')).toBe('a\nb');
  });

  it('drops the rest after an unterminated comment', () => {
    expect(textOf('<p>keep</p><!-- never closed <p>gone</p>')).toBe('keep');
  });

  it('drops a multi-line script with attributes and ignores case', () => {
    const html = '<p>a</p><SCRIPT type="text/javascript" src="x.js">\nif (a < b) { go(); }\n</Script ><p>b</p>';
    expect(textOf(html)).toBe('a\nb');
  });

  it('drops head contents and doctype', () => {
    expect(textOf('<!DOCTYPE html><html><head><title>T</title></head><body><p>x</p></body></html>')).toBe('x');
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
