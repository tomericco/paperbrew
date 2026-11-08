/** How the brewed magazine is laid out on paper: single sheets, or a folded A4 booklet. */
export const PAPER_LAYOUTS = ['flat', 'booklet'] as const;
export type PaperLayout = (typeof PAPER_LAYOUTS)[number];
