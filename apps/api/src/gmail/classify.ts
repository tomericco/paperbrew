import { detectScript } from '../brew/direction.js';
import { zeroShot } from './model.js';

export const LABELS: readonly string[] = [
  'an essay, analysis or reporting',
  'a sales promotion or discount',
  'a product or company update',
  'a receipt, notification or alert',
  'a list of links',
];
export const EDITORIAL_LABEL = LABELS[0];
export const EDITORIAL_MIN_SCORE = 0.5;

const SHORT: Record<string, string> = {
  [LABELS[0]]: 'editorial',
  [LABELS[1]]: 'promotion',
  [LABELS[2]]: 'update',
  [LABELS[3]]: 'notification',
  [LABELS[4]]: 'links',
};

const INPUT_WORDS = 400;
/** Bounds sender-controlled text by characters: one huge token must not reach the tokenizer or detectScript. */
export const CLASSIFIER_MAX_CHARS = 4000;

export function classifierInput(subject: string, text: string): string {
  const input = `${subject}\n${text.trim().split(/\s+/).slice(0, INPUT_WORDS).join(' ')}`;
  return input.slice(0, CLASSIFIER_MAX_CHARS);
}

export function decide(result: { labels: string[]; scores: number[] }): { editorial: boolean; reason: string } {
  let top = 0;
  for (let i = 1; i < result.scores.length; i++) if (result.scores[i] > result.scores[top]) top = i;
  const label = result.labels[top];
  const score = result.scores[top];
  return {
    editorial: label === EDITORIAL_LABEL && score >= EDITORIAL_MIN_SCORE,
    reason: `${SHORT[label] ?? label} ${score.toFixed(2)}`,
  };
}

export async function classifyEmail(
  email: { subject: string; html: string; text: string },
  infer: typeof zeroShot = zeroShot,
): Promise<{ editorial: boolean; reason: string }> {
  // The model is English-only, so Hebrew and Arabic mail passes on the rules alone.
  if (detectScript((email.text || email.html).slice(0, CLASSIFIER_MAX_CHARS)) !== 'latin') {
    return { editorial: true, reason: 'rules-only (non-English)' };
  }
  return decide(await infer(classifierInput(email.subject, email.text), [...LABELS]));
}
