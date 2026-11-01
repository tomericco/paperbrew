import { readFileSync } from 'node:fs';

const SENTENCES = [
  'Reading slowly is not the same as reading less; it is choosing to stay with one idea long enough for it to change you.',
  'Most of what we save is never opened again, because an endless list gives us no reason to begin and no moment to stop.',
  'Paper removes the small negotiations that a screen invites, the tab that blinks, the message that arrives mid-sentence.',
  'A finished issue has a last page, and reaching it is a small satisfaction that a feed is designed never to give.',
];

export function paragraphs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${SENTENCES[i % 4]} ${SENTENCES[(i + 1) % 4]} ${SENTENCES[(i + 2) % 4]}`);
}

export function forwardedNewsletterFixture(paragraphCount = 12): unknown {
  return loadFixture('postmark-forwarded-newsletter.json', paragraphCount);
}

/** A Gmail forward as CloudMailin posts it (JSON Normalized), to 4fcb639be7306607cef6+amber-otter-lantern@cloudmailin.net. */
export function cloudmailinForwardedFixture(paragraphCount = 12): Record<string, any> {
  return loadFixture('cloudmailin-forwarded.json', paragraphCount) as Record<string, any>;
}

function loadFixture(name: string, paragraphCount: number): unknown {
  const ps = paragraphs(paragraphCount);
  const raw = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return JSON.parse(
    raw
      .replace('__PARAGRAPHS__', ps.join('\\n\\n'))
      .replace('__HTML_PARAGRAPHS__', ps.map((p) => `<p>${p}</p>`).join('')),
  );
}
