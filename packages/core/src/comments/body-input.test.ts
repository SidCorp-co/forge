/**
 * The comment write door's own field: a body is stored as it was written, and a body with nothing
 * in it is refused by name. Leading whitespace decides what markdown draws, so a door that strips
 * the first line's indent and no other line's hands the parser a body its author never wrote.
 * Whether a record is read out of it afterwards is the record reader's rule, not this door's.
 */

import { describe, expect, it } from 'vitest';
import { COMMENT_BODY_MAX_CHARS, commentBodyField } from './body-input.js';

const FENCE = '```';

const blockAt = (indent: string): string =>
  [`${indent}${FENCE}forge-record`, `${indent}criterion: 6`, `${indent}${FENCE}`].join('\n');

describe('the body a comment is stored with', () => {
  it('keeps the four spaces that make the first line an indented code block', () => {
    const body = blockAt('    ');
    expect(commentBodyField.parse(body)).toBe(body);
  });

  it('keeps an indent within the three spaces markdown reads as a fence', () => {
    for (const indent of [' ', '  ', '   ']) {
      const body = blockAt(indent);
      expect(commentBodyField.parse(body)).toBe(body);
    }
  });

  it('keeps the blank lines a body opens with', () => {
    expect(commentBodyField.parse('\n\nnote')).toBe('\n\nnote');
  });

  it('keeps what follows the last line', () => {
    expect(commentBodyField.parse('note\n\n')).toBe('note\n\n');
  });
});

describe('a body with nothing in it', () => {
  it('is refused by name rather than by a length the caller cannot see', () => {
    const refused = commentBodyField.safeParse('   \n\t\n');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain('whitespace');
  });

  it('is refused when it is empty', () => {
    expect(commentBodyField.safeParse('').success).toBe(false);
  });
});

describe('the cap', () => {
  it('accepts a body at it and refuses one past it', () => {
    expect(commentBodyField.safeParse('x'.repeat(COMMENT_BODY_MAX_CHARS)).success).toBe(true);
    expect(commentBodyField.safeParse('x'.repeat(COMMENT_BODY_MAX_CHARS + 1)).success).toBe(false);
  });
});
