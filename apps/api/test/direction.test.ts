import { describe, expect, it } from 'vitest';
import { detectScript, directionOf, issueDirection } from '../src/brew/direction.js';

describe('detectScript', () => {
  it('detects Hebrew', () => {
    expect(detectScript('<p>שלום עולם, זה מאמר</p>')).toBe('hebrew');
  });

  it('detects Arabic', () => {
    expect(detectScript('<p>مرحبا بالعالم، هذه مقالة عن الكتب</p>')).toBe('arabic');
  });

  it('detects Latin', () => {
    expect(detectScript('<p>Hello world</p>')).toBe('latin');
  });

  it('defaults to Latin for empty input', () => {
    expect(detectScript('')).toBe('latin');
  });

  it('uses the majority script, not the first character', () => {
    const html =
      '<p>זהו מאמר ארוך בעברית על תכנות ועל כתיבת קוד טוב <code>console.log</code> ' +
      'https://example.com/post</p>';
    expect(detectScript(html)).toBe('hebrew');
  });

  it('stays Latin when a single Hebrew word sits in English text', () => {
    expect(detectScript('<p>This is mostly an English article with one word, שלום, inside.</p>')).toBe('latin');
  });
});

describe('directionOf', () => {
  it('maps scripts to directions', () => {
    expect(directionOf('latin')).toBe('ltr');
    expect(directionOf('hebrew')).toBe('rtl');
    expect(directionOf('arabic')).toBe('rtl');
  });
});

describe('issueDirection', () => {
  it('is rtl only when every article is right-to-left', () => {
    expect(issueDirection(['hebrew', 'arabic'])).toBe('rtl');
    expect(issueDirection(['hebrew', 'latin'])).toBe('ltr');
    expect(issueDirection([])).toBe('ltr');
  });
});
