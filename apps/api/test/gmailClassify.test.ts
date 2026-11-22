import { describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_MAX_CHARS, classifierInput, classifyEmail, decide, EDITORIAL_LABEL, LABELS } from '../src/gmail/classify.js';

const [, PROMO, UPDATE, NOTIFICATION, LINKS] = LABELS;

describe('decide', () => {
  it('accepts editorial on top at or above 0.5', () => {
    expect(decide({ labels: [EDITORIAL_LABEL, PROMO], scores: [0.62, 0.38] })).toEqual({
      editorial: true,
      reason: 'editorial 0.62',
    });
  });

  it('rejects editorial on top below 0.5', () => {
    expect(decide({ labels: [EDITORIAL_LABEL, PROMO], scores: [0.41, 0.39] })).toEqual({
      editorial: false,
      reason: 'editorial 0.41',
    });
  });

  it('rejects when another label is on top', () => {
    expect(decide({ labels: [PROMO, EDITORIAL_LABEL], scores: [0.71, 0.29] })).toEqual({
      editorial: false,
      reason: 'promotion 0.71',
    });
  });

  it('uses short names for the other labels', () => {
    expect(decide({ labels: [UPDATE], scores: [0.5] }).reason).toBe('update 0.50');
    expect(decide({ labels: [NOTIFICATION], scores: [0.5] }).reason).toBe('notification 0.50');
    expect(decide({ labels: [LINKS], scores: [0.5] }).reason).toBe('links 0.50');
  });
});

describe('classifierInput', () => {
  it('is the subject, a newline, then the first 400 words', () => {
    const text = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    const out = classifierInput('Subject', text);
    const [subject, body] = out.split('\n');
    expect(subject).toBe('Subject');
    expect(body.split(' ')).toHaveLength(400);
    expect(body.endsWith('w399')).toBe(true);
  });
});

describe('classifierInput bounds', () => {
  it('never exceeds the character cap, even for one giant token, and keeps the subject', () => {
    const out = classifierInput('Subject line', 'x'.repeat(500_000));
    expect(out.length).toBeLessThanOrEqual(CLASSIFIER_MAX_CHARS);
    expect(out.startsWith('Subject line\n')).toBe(true);
  });
});

describe('classifyEmail', () => {
  const english = { subject: 'S', html: '<p>An essay about things.</p>', text: 'An essay about things.' };

  it('skips the model for Hebrew', async () => {
    const infer = vi.fn();
    const text = 'זהו מאמר ארוך על דברים חשובים בחיים ובעולם';
    const out = await classifyEmail({ subject: 'נושא', html: `<p>${text}</p>`, text }, infer);
    expect(out).toEqual({ editorial: true, reason: 'rules-only (non-English)' });
    expect(infer).not.toHaveBeenCalled();
  });

  it('skips the model for Arabic', async () => {
    const infer = vi.fn();
    const text = 'هذا مقال طويل عن أشياء مهمة في الحياة والعالم';
    const out = await classifyEmail({ subject: 'موضوع', html: '', text }, infer);
    expect(out.reason).toBe('rules-only (non-English)');
    expect(infer).not.toHaveBeenCalled();
  });

  it('decides from the model result for English', async () => {
    const infer = vi.fn().mockResolvedValue({ labels: [EDITORIAL_LABEL, PROMO], scores: [0.8, 0.2] });
    expect(await classifyEmail(english, infer)).toEqual({ editorial: true, reason: 'editorial 0.80' });
    expect(infer).toHaveBeenCalledWith(classifierInput('S', english.text), [...LABELS]);
  });

  it('inference error propagates', async () => {
    const infer = vi.fn().mockRejectedValue(new Error('model down'));
    await expect(classifyEmail(english, infer)).rejects.toThrow('model down');
  });

  it('stays fast on a text made only of "<"', async () => {
    const infer = vi.fn().mockResolvedValue({ labels: [EDITORIAL_LABEL], scores: [0.9] });
    const start = performance.now();
    await classifyEmail({ subject: 'x', html: '', text: '<'.repeat(500_000) }, infer);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('detects the script from the head of a long Hebrew text and skips the model', async () => {
    const infer = vi.fn();
    const text = 'זהו מאמר ארוך על דברים '.repeat(1000);
    expect(text.length).toBeGreaterThan(CLASSIFIER_MAX_CHARS);
    const out = await classifyEmail({ subject: 'נושא', html: '', text }, infer);
    expect(out).toEqual({ editorial: true, reason: 'rules-only (non-English)' });
    expect(infer).not.toHaveBeenCalled();
  });
});
