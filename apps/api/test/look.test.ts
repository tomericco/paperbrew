import { describe, expect, it } from 'vitest';
import { PAPER_LOOKS, isPaperLook } from '../src/brew/look.js';

describe('isPaperLook', () => {
  it.each(PAPER_LOOKS)('accepts %s', (look) => {
    expect(isPaperLook(look)).toBe(true);
  });

  it('lists the looks, broadsheet first', () => {
    expect(PAPER_LOOKS).toEqual(['broadsheet', 'fieldnotes', 'zine']);
  });

  it.each(['x', '', 'Zine', null, undefined, 3, {}])('rejects %j', (value) => {
    expect(isPaperLook(value)).toBe(false);
  });
});
