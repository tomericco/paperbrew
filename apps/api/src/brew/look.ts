/** The visual look of a brewed magazine. `broadsheet` is the original design and the default. */
export const PAPER_LOOKS = ['broadsheet', 'fieldnotes', 'zine'] as const;
export type PaperLook = (typeof PAPER_LOOKS)[number];

export const isPaperLook = (v: unknown): v is PaperLook => PAPER_LOOKS.includes(v as PaperLook);
