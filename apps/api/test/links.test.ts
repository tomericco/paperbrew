import { describe, expect, it } from 'vitest';
import { cleanUrl } from '../src/links/clean.js';
import { extractLinks, isArticleCandidate } from '../src/links/extract.js';

describe('cleanUrl', () => {
  it('strips tracking params and fragments', () => {
    expect(cleanUrl('https://Blog.Example.com/post?utm_source=hn&utm_medium=x&id=3#top')).toBe('https://blog.example.com/post?id=3');
  });
  it('unwraps Google and Outlook redirect wrappers', () => {
    expect(cleanUrl('https://www.google.com/url?q=https://example.com/a?utm_campaign=z&sa=D')).toBe('https://example.com/a');
    expect(cleanUrl('https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fb&data=x')).toBe('https://example.com/b');
  });
  it('rejects non-http schemes', () => {
    expect(cleanUrl('mailto:me@example.com')).toBeNull();
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('isArticleCandidate', () => {
  it('skips unsubscribe, social, images and bare homepages', () => {
    expect(isArticleCandidate('https://news.example.com/unsubscribe?u=1')).toBe(false);
    expect(isArticleCandidate('https://x.com/someone/status/1')).toBe(false);
    expect(isArticleCandidate('https://cdn.example.com/logo.png')).toBe(false);
    expect(isArticleCandidate('https://example.com/')).toBe(false);
    expect(isArticleCandidate('https://example.com/essays/slow-reading')).toBe(true);
  });
});

describe('extractLinks', () => {
  it('takes article links from html and text, skipping junk and duplicates', () => {
    const html = `
      <p>Two good reads:</p>
      <a href="https://mcfunley.com/choose-boring-technology?utm_source=newsletter">Choose Boring Technology</a>
      <a href="http://incompleteideas.net/IncIdeas/BitterLesson.html">The Bitter Lesson</a>
      <a href="https://example.com/x"><img src="https://example.com/banner.png"></a>
      <a href="https://list.example.com/manage-preferences">Manage preferences</a>
      <a href="https://example.com/p/abc">Unsubscribe</a>`;
    const text = 'Also https://mcfunley.com/choose-boring-technology and https://paulgraham.com/greatwork.html.';
    expect(extractLinks({ html, text })).toEqual([
      'https://mcfunley.com/choose-boring-technology',
      'http://incompleteideas.net/IncIdeas/BitterLesson.html',
      'https://paulgraham.com/greatwork.html',
    ]);
  });
});
