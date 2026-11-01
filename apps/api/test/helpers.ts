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
  const ps = paragraphs(paragraphCount);
  const raw = readFileSync(new URL('./fixtures/postmark-forwarded-newsletter.json', import.meta.url), 'utf8');
  return JSON.parse(
    raw
      .replace('__PARAGRAPHS__', ps.join('\\n\\n'))
      .replace('__HTML_PARAGRAPHS__', ps.map((p) => `<p>${p}</p>`).join('')),
  );
}
