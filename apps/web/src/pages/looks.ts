/** The magazine looks. Mirrors the API's `PAPER_LOOKS` (apps/api/src/brew/look.ts); the two lists must agree. */
export type PaperLook = 'broadsheet' | 'fieldnotes' | 'zine';

export const PAPER_LOOKS: { value: PaperLook; label: string; note: string; accent: string }[] = [
  { value: 'broadsheet', label: 'Broadsheet', note: 'Serif headlines, ink black', accent: '#151412' },
  { value: 'fieldnotes', label: 'Field Notes', note: 'Clean sans, burnt orange', accent: '#d9480f' },
  { value: 'zine', label: 'Zine', note: 'Mono headlines, blue', accent: '#1d4ed8' },
];

/** The typefaces each look sets headlines (`display`) and running text (`body`) in, for the previews. */
export const LOOK_FONTS: Record<PaperLook, { display: string; body: string }> = {
  broadsheet: { display: "'Fraunces', Georgia, serif", body: "'Source Serif 4', Georgia, serif" },
  fieldnotes: { display: "'DM Sans', system-ui, sans-serif", body: "'DM Sans', system-ui, sans-serif" },
  zine: { display: "'Space Mono', ui-monospace, Menlo, monospace", body: "'Source Serif 4', Georgia, serif" },
};

export const isPaperLook = (value: unknown): value is PaperLook => PAPER_LOOKS.some((look) => look.value === value);

/** A stored look as a look: an unknown or missing value is the default, as on the API. */
export const toPaperLook = (value: unknown): PaperLook => (isPaperLook(value) ? value : 'broadsheet');

export const lookInfo = (look: PaperLook) => PAPER_LOOKS.find((l) => l.value === look) ?? PAPER_LOOKS[0];
