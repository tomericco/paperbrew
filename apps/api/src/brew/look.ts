/** The visual look of a brewed magazine. `broadsheet` is the original design and the default. */
export const PAPER_LOOKS = ['broadsheet', 'fieldnotes', 'zine'] as const;
export type PaperLook = (typeof PAPER_LOOKS)[number];

export const isPaperLook = (v: unknown): v is PaperLook => PAPER_LOOKS.includes(v as PaperLook);

/** What a user without a (valid) stored look gets. */
export const DEFAULT_LOOK: PaperLook = 'broadsheet';

/** A stored `users.paper_look` as a look: an unknown or missing value is the default. */
export const toPaperLook = (v: unknown): PaperLook => (isPaperLook(v) ? v : DEFAULT_LOOK);

/** Extra Google Fonts query parts (each starting with `&family=`) a look needs. Source Serif 4 is always loaded. */
export function lookFontFamilies(look: PaperLook): string {
  switch (look) {
    case 'fieldnotes':
      return '&family=DM+Sans:ital,opsz,wght@0,9..40,300..700;1,9..40,300..700';
    case 'zine':
      return '&family=Space+Mono:wght@400;700';
    default:
      return '';
  }
}

// Every stack ends with the Hebrew and Arabic faces, so right-to-left articles keep their fonts.
const RTL_FALLBACK = "'Frank Ruhl Libre', 'Noto Naskh Arabic'";

/**
 * CSS appended after the base (and booklet) styles. Looks only override: font families and accent colours,
 * never sizes, so both layouts keep their own. `broadsheet` is the base design and adds nothing.
 */
export function lookCss(look: PaperLook): string {
  switch (look) {
    case 'fieldnotes': {
      const sans = `'DM Sans', ${RTL_FALLBACK}, system-ui, sans-serif`;
      return `
/* Look: fieldnotes. DM Sans throughout, orange accent. */
body, .masthead, .headline, .cover-title .t, .byline, .body h2, .body h3, .body h4, .body h5, .body h6 { font-family: ${sans}; }
.cover .rule.thick { border-top-color: #d9480f; }
.kicker { color: #d9480f; }
.body blockquote { border-inline-start-color: #d9480f; }
`;
    }
    case 'zine': {
      const mono = `'Space Mono', ${RTL_FALLBACK}, ui-monospace, Menlo, monospace`;
      return `
/* Look: zine. Space Mono headings over the Source Serif 4 body, blue accent. */
.masthead, .headline, .cover-title .t, .body h2, .body h3, .body h4, .body h5, .body h6 { font-family: ${mono}; }
.cover .rule.thick { border-top-color: #1d4ed8; }
.kicker { color: #1d4ed8; }
.body blockquote { border-inline-start-color: #1d4ed8; }
`;
    }
    default:
      return '';
  }
}
