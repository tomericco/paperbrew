export type Script = 'latin' | 'hebrew' | 'arabic';
export type Direction = 'ltr' | 'rtl';

const HEBREW = /[֐-׿יִ-ﭏ]/g;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-zÀ-ɏ]/g;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/** The dominant script of an article's HTML, by letter count (tags stripped). */
export function detectScript(html: string): Script {
  const text = html.replace(/<[^>]*>/g, ' ');
  const hebrew = count(text, HEBREW);
  const arabic = count(text, ARABIC);
  const latin = count(text, LATIN);

  const [rtl, rtlCount]: [Script, number] = hebrew >= arabic ? ['hebrew', hebrew] : ['arabic', arabic];
  return rtlCount > latin ? rtl : 'latin';
}

export function directionOf(script: Script): Direction {
  return script === 'latin' ? 'ltr' : 'rtl';
}

/** The issue binds right-to-left only when every article is right-to-left. */
export function issueDirection(scripts: Script[]): Direction {
  return scripts.length > 0 && scripts.every((s) => directionOf(s) === 'rtl') ? 'rtl' : 'ltr';
}
