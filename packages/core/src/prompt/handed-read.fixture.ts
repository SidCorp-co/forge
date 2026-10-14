import { readAsHanded } from './sanitize.js';

/** Every character an agent's read takes out, found by handing it every code point once, so no list here can drift from the read's. */
export function charactersTakenOut(): string[] {
  const all: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp < 0xd800 || cp > 0xdfff) all.push(String.fromCodePoint(cp));
  }
  const text = all.join('');
  const kept = new Uint8Array(text.length);
  for (const at of readAsHanded(text).origin) kept[at] = 1;
  const out: string[] = [];
  let at = 0;
  for (const one of all) {
    if (kept[at] === 0) out.push(one);
    at += one.length;
  }
  return out;
}

/** What an agent's read takes out that is more than one character: a comment's delimiters, the frame's label. */
export const SEQUENCES_TAKEN_OUT: ReadonlyArray<[string, string]> = [
  ['an empty HTML comment', '<!---->'],
  ['the frame label', 'UNTRUSTED_DATA'],
  ['the frame label in lower case', 'untrusted_data'],
];

/** How a test names one character: its code point, since the character itself prints as nothing. */
export const codePoint = (one: string): string =>
  `U+${(one.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`;
