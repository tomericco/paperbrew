import { describe, expect, it } from 'vitest';
import { magazineDirection, renderMagazine, type BrewArticle } from '../src/brew/render.js';

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
  it('renders the masthead, the articles in order and both bodies, with no contents page', () => {
    const html = renderMagazine({ articles: [first, second], date: DATE });
    expect(html).toMatch(/<h1[^>]*>Paperbrew<\/h1>/);
    expect(html).not.toContain('class="contents"');
    expect(html).not.toContain('>Contents<');

    const articles = after(html, 'class="article"');
    const a = articles.indexOf('Choose Boring Technology');
    const b = articles.indexOf('The Bitter Lesson');
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

  it('skips articles with null or empty content', () => {
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

  it('numbers every page in the footer except the cover', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toMatch(/@bottom-center\s*\{[^}]*content:\s*counter\(page\)/);
    expect(html).toMatch(/@page\s*:first\s*\{\s*@bottom-center\s*\{\s*content:\s*none/);
  });

  it('sets article bodies in a single column', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).not.toMatch(/column-count/);
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
    const cover = html.slice(0, html.indexOf('class="article"'));
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

const hebrew = article({
  title: 'כותרת בעברית',
  author: 'מחבר',
  contentHtml: '<p>זהו גוף המאמר בעברית עם מספיק מילים כדי לזהות את הכתב.</p>',
});
const arabic = article({
  title: 'عنوان',
  contentHtml: '<p>هذا نص المقال باللغة العربية مع كلمات كافية لتحديد الكتابة.</p>',
});

describe('booklet layout and right-to-left', () => {
  it('flat layout keeps the A4 page', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toMatch(/size:\s*A4/);
    expect(html).not.toMatch(/size:\s*A5/);
  });

  it('booklet layout sets an A5 page with the booklet sizes', () => {
    const html = renderMagazine({ articles: [first], date: DATE, layout: 'booklet' });
    expect(html).toMatch(/size:\s*A5;\s*margin:\s*14mm 16mm 16mm/);
    expect(html).toMatch(/\.cover\s*\{[^}]*height:\s*180mm/);
    expect(html).toContain('counter(page)');
    expect(html).not.toMatch(/size:\s*A4/);
  });

  it('marks Hebrew articles rtl with lang he, Latin ones without dir', () => {
    const html = renderMagazine({ articles: [hebrew, first], date: DATE });
    expect(html).toContain('<article class="article" dir="rtl" lang="he">');
    expect(html).toContain('<article class="article">');
  });

  it('marks Arabic articles lang ar and turns off their drop cap', () => {
    const html = renderMagazine({ articles: [arabic], date: DATE });
    expect(html).toContain('lang="ar"');
    expect(html).toMatch(/\.article:lang\(ar\)\s*\.body > p:first-of-type::first-letter\s*\{[^}]*float:\s*none/);
  });

  it('isolates the English kicker and keeps the source link ltr', () => {
    const html = renderMagazine({ articles: [hebrew], date: DATE });
    expect(html).toContain('<bdi>01</bdi> · <bdi>mcfunley.com</bdi> · <bdi>9 min read</bdi>');
    expect(html).toContain('<p class="source mono" dir="ltr">');
    const latin = renderMagazine({ articles: [first], date: DATE });
    expect(latin).not.toContain('<bdi>');
    expect(latin).toContain('<p class="source mono">');
  });

  it('uses logical properties so rtl mirrors', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toContain('float: inline-start');
    expect(html).toContain('border-inline-start');
    expect(html).toContain('padding-inline-start');
    expect(html).not.toContain('text-align: left');
    expect(html).not.toContain('float: left');
    expect(html).not.toContain('border-left');
    expect(html).not.toContain('padding-left');
  });

  it('loads Hebrew and Arabic fonts', () => {
    const html = renderMagazine({ articles: [first], date: DATE });
    expect(html).toContain('Frank+Ruhl+Libre');
    expect(html).toContain('Noto+Naskh+Arabic');
    expect(html).toContain("'Source Serif 4', 'Frank Ruhl Libre', 'Noto Naskh Arabic'");
  });

  it('magazineDirection', () => {
    expect(magazineDirection([hebrew, hebrew])).toBe('rtl');
    expect(magazineDirection([hebrew, first])).toBe('ltr');
    expect(magazineDirection([])).toBe('ltr');
    expect(magazineDirection([article({ contentHtml: null }), hebrew])).toBe('rtl');
  });
});
