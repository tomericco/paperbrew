import { describe, expect, it } from 'vitest';
import { renderMagazine, type BrewArticle } from '../src/brew/render.js';

const DATE = new Date('2026-11-01T12:00:00Z');

function article(over: Partial<BrewArticle> = {}): BrewArticle {
  return {
    title: 'Choose Boring Technology',
    author: 'Dan McKinley',
    siteName: 'mcfunley.com',
    sourceUrl: 'https://mcfunley.com/choose-boring-technology',
    readingMinutes: 9,
    contentHtml: '<p>Body of the first piece.</p>',
    ...over,
  };
}

const first = article();
const second = article({
  title: 'The Bitter Lesson',
  author: 'Rich Sutton',
  siteName: 'incompleteideas.net',
  sourceUrl: 'http://www.incompleteideas.net/IncIdeas/BitterLesson.html',
  readingMinutes: 5,
  contentHtml: '<p>Body of the second piece.</p><h2>A heading</h2><p>More.</p>',
});

/** The part of the document after the first occurrence of `marker`. */
function after(html: string, marker: string): string {
  const i = html.indexOf(marker);
  expect(i, `marker ${marker}`).toBeGreaterThanOrEqual(0);
  return html.slice(i);
}

describe('renderMagazine', () => {
  it('renders the masthead, contents in order and both bodies', () => {
    const html = renderMagazine({ articles: [first, second], date: DATE });
    expect(html).toMatch(/<h1[^>]*>Paperbrew<\/h1>/);

    const contents = after(html, 'class="contents"');
    const a = contents.indexOf('Choose Boring Technology');
    const b = contents.indexOf('The Bitter Lesson');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);

    expect(html).toContain('<p>Body of the first piece.</p>');
    expect(html).toContain('<p>Body of the second piece.</p><h2>A heading</h2><p>More.</p>');
    expect(html.indexOf('Body of the first piece.')).toBeLessThan(html.indexOf('Body of the second piece.'));
  });

  it('is one self-contained document with the design fonts', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono');
    expect(html).toContain('Source+Serif+4');
    expect(html).not.toMatch(/<script/i);
  });

  it('formats the cover date', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toContain('Sunday, 1 November 2026');
  });

  it('escapes titles, authors, site names and URLs', () => {
    const html = renderMagazine({
      articles: [
        article({
          title: '<script>alert(1)</script> & co',
          author: '<b>Mallory</b> & "friends"',
          siteName: '<i>site</i>',
          sourceUrl: 'https://example.com/?a=1&b=<x>',
        }),
      ],
      date: DATE,
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;b&gt;Mallory&lt;/b&gt; &amp; &quot;friends&quot;');
    expect(html).not.toContain('<b>Mallory</b>');
    expect(html).toContain('&lt;i&gt;site&lt;/i&gt;');
    expect(html).toContain('https://example.com/?a=1&amp;b=&lt;x&gt;');
    expect(html).not.toContain('b=<x>');
  });

  it('skips articles with null or empty content in the contents and the body', () => {
    const html = renderMagazine({
      articles: [
        article({ title: 'Pending one', contentHtml: null }),
        first,
        article({ title: 'Empty one', contentHtml: '   ' }),
      ],
      date: DATE,
    });
    expect(html).not.toContain('Pending one');
    expect(html).not.toContain('Empty one');
    expect(html).toContain('1 piece<');
    // The only article is number 01.
    expect(html).toContain('01 · mcfunley.com · 9 min read');
  });

  it('sets an A4 page', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
  });

  it('shows total reading time on the cover and per-article minutes', () => {
    const long = renderMagazine({
      articles: [article({ readingMinutes: 45 }), article({ readingMinutes: 40 })],
      date: DATE,
    });
    expect(long).toContain('About 1 h 25 min');
    expect(long).toContain('2 pieces');
    expect(long).toContain('45 min read');
    expect(long).toContain('40 min read');

    const short = renderMagazine({ articles: [first, second], date: DATE });
    expect(short).toContain('>14 min<');
    expect(short).not.toContain('About 1 h');
    expect(short).toContain('02 · incompleteideas.net · 5 min read');
  });

  it('lists up to three titles on the cover and counts the rest', () => {
    const many = ['One', 'Two', 'Three', 'Four', 'Five'].map((t) => article({ title: t }));
    const html = renderMagazine({ articles: many, date: DATE });
    const cover = html.slice(0, html.indexOf('class="contents"'));
    expect(cover).toContain('One');
    expect(cover).toContain('Three');
    expect(cover).not.toContain('Four');
    expect(cover).toContain('and 2 more');
  });

  it('ends each article with its source link', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toContain('Read it online');
    expect(html).toContain('mcfunley.com/choose-boring-technology');
  });

  it('with no articles, prints the cover and an empty-state line', () => {
    const html = renderMagazine({ articles: [article({ contentHtml: null })], date: DATE });
    expect(html).toMatch(/<h1[^>]*>Paperbrew<\/h1>/);
    expect(html).toContain('Nothing to brew yet. Forward some articles first.');
    expect(html).not.toContain('class="contents"');
    expect(html).not.toContain('class="article"');
  });

  it('survives missing title, author, site and minutes', () => {
    const html = renderMagazine({
      articles: [
        { title: null, author: null, siteName: null, sourceUrl: null, readingMinutes: null, contentHtml: '<p>x</p>' },
      ],
      date: DATE,
    });
    expect(html).toContain('Untitled');
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('Read it online');
  });
});
