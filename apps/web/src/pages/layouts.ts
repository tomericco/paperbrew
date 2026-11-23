export type PaperLayout = 'flat' | 'booklet';

export const LAYOUTS: { value: PaperLayout; label: string; hint: string }[] = [
  { value: 'flat', label: 'Flat A4', hint: 'Single pages, staple in the corner.' },
  { value: 'booklet', label: 'Booklet (A4, folded)', hint: 'Print two-sided, flip on short edge, fold and staple.' },
];

/** The `error` of a failed API response, or `fallback` when the body has none. */
export async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}
