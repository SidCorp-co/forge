/**
 * What a reader of a comment sees, as a string, with no database: the encodings a literal match on
 * the stored body cannot see through, and the places where markdown draws a character as written.
 */

import { describe, expect, it } from 'vitest';
import { readAsText } from './reading.js';

describe('the text a comment reads as', () => {
  it.each([
    ['a numeric character reference', 'a&#98;c', 'abc'],
    ['a hexadecimal one', 'a&#x62;c', 'abc'],
    ['a named one outside the short list', 'a&colon;b&excl;', 'a:b!'],
    ['emphasis marks inside a word', 'ad**min**', 'admin'],
    ['a link around part of a word', '[ad](https://x.test)min', 'admin'],
    ['a backslash escape', 'a\\_b', 'a_b'],
    ['an empty tag inside a word', 'ad<b></b>min', 'admin'],
    ['a tag around part of a word', 'ad<i>mi</i>n', 'admin'],
    ['a comment inside a word', 'ad<!-- x -->min', 'admin'],
    ["an image's alt text", '![ad](x.png)min', 'admin'],
    ['a character reference inside block HTML', '<div>ad&#109;in</div>', 'admin'],
  ])('joins %s', (_how, body, read) => {
    expect(readAsText(body)).toBe(read);
  });

  it('draws a code span and a fenced block as written, character references included', () => {
    expect(readAsText('`a&#98;c`')).toBe('a&#98;c');
    expect(readAsText('```\na&#98;c\n```')).toBe('a&#98;c');
  });

  it('keeps blocks on lines of their own, so a value is not made of the end of one and the start of the next', () => {
    expect(readAsText('ad\n\nmin')).toBe('ad\nmin');
    expect(readAsText('- ad\n- min')).toBe('ad\nmin');
  });

  it('reads an empty body and a body of plain words as they are', () => {
    expect(readAsText('')).toBe('');
    expect(readAsText('just words, 12 of them')).toBe('just words, 12 of them');
  });

  it('terminates on markup nested in markup', () => {
    expect(readAsText('<div><div>&lt;div&gt;x</div></div>')).toBe('<div>x');
  });
});
