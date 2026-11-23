export type Layout = 'flat' | 'booklet';

/** Arguments for `lp`. Booklet PDFs are A4 landscape sheets printed two-sided and flipped on the short edge. */
export function lpArgs(file: string, layout: Layout, printer: string | null): string[] {
  const args: string[] = [];
  if (printer) args.push('-d', printer);
  if (layout === 'booklet') args.push('-o', 'sides=two-sided-short-edge');
  args.push('-o', 'media=A4', file);
  return args;
}
