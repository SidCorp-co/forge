import { describe, expect, it } from 'vitest';
import { foreignScriptChars, storableAgainstSource } from './script-guard.js';

const OBHOD = 'обход';
const FAK = 'фак';
const CYRILLIC_LEAK = `dieu kien la cach duy nhat de ${OBHOD} qua`;
const HYBRID_LEAK = `dua tren bon ${FAK}t doc duoc`;
const ASCII_SOURCE = 'the only way to bypass the condition, based on four readable facts';

// cm:why the Vietnamese fixture alone is spelled in `\u` escapes: `scripts/check-source-language.mjs` flags Latin diacritics (its `NON_ENGLISH` range) and nothing else, so the Cyrillic and Han fixtures pass it literally while a literal Vietnamese one would not. The escapes ARE the fixture — this suite's subject is which characters the guard names, and a waiver comment would only silence the language gate while leaving the same bytes to assert over.
const VI_PRECOMPOSED = 'v\u01b0\u1ee3t qua \u0111i\u1ec1u ki\u1ec7n \u0111\u00e3 n\u00eau';
const HAN_BEIJING = '北京';
const HAN_CITY = '市';

describe('foreignScriptChars — the leak it exists to refuse', () => {
  it('names every Cyrillic character in a rendering of an ASCII source', () => {
    expect(foreignScriptChars(CYRILLIC_LEAK, ASCII_SOURCE).sort()).toEqual(
      [...new Set(OBHOD)].sort(),
    );
  });

  it('names the Cyrillic hiding inside an otherwise Latin word', () => {
    expect(foreignScriptChars(HYBRID_LEAK, ASCII_SOURCE).sort()).toEqual([...FAK].sort());
  });

  it('refuses both by the predicate the call sites use', () => {
    expect(storableAgainstSource(CYRILLIC_LEAK, ASCII_SOURCE)).toBe(false);
    expect(storableAgainstSource(HYBRID_LEAK, ASCII_SOURCE)).toBe(false);
  });
});

describe('foreignScriptChars — what must still pass', () => {
  it('passes Vietnamese with its diacritics precomposed', () => {
    expect(foreignScriptChars(VI_PRECOMPOSED, ASCII_SOURCE)).toEqual([]);
    expect(storableAgainstSource(VI_PRECOMPOSED, ASCII_SOURCE)).toBe(true);
  });

  // cm:why NFD is the case a range check over precomposed Vietnamese letters silently fails: the same words are a base letter plus U+0300-range combining marks, which is Script=Inherited and matches no such range
  it('passes the same Vietnamese spelled NFD', () => {
    const nfd = VI_PRECOMPOSED.normalize('NFD');
    expect(nfd).not.toBe(VI_PRECOMPOSED);
    expect(foreignScriptChars(nfd, ASCII_SOURCE)).toEqual([]);
  });

  it('passes digits, punctuation, symbols and emoji', () => {
    expect(foreignScriptChars('v2.1 — "ok" (100%) ✅ →', ASCII_SOURCE)).toEqual([]);
  });

  it('passes an empty rendering', () => {
    expect(foreignScriptChars('', ASCII_SOURCE)).toEqual([]);
    expect(storableAgainstSource('', ASCII_SOURCE)).toBe(true);
  });
});

describe("foreignScriptChars — the source's own scripts", () => {
  it('lets through the characters the source itself used', () => {
    expect(foreignScriptChars(`van phong ${HAN_BEIJING}`, `the ${HAN_BEIJING} office`)).toEqual([]);
  });

  // REVERSED 2026-09-18. This asserted the opposite until then: a source naming `北京` licensed
  // those two characters and no other Han. Extraction produces paraphrases, not quotations, so that
  // rule refused the ordinary rewording of its own input — measured on Chinese, Korean and Thai,
  // where the alphabet is too large to be exhausted by a few comments the way Cyrillic's 33 letters
  // are. The licence is now the SCRIPT the source used.
  it('lets through a character of a script the source used, which it did not use itself', () => {
    expect(
      foreignScriptChars(`van phong ${HAN_BEIJING}${HAN_CITY}`, `the ${HAN_BEIJING} office`),
    ).toEqual([]);
  });

  it("lets a paraphrase reword its source in that source's own script", () => {
    expect(foreignScriptChars('部署分支是 master', '上线用的分支不是 main，是 master')).toEqual([]);
  });

  it('licenses one script without licensing another', () => {
    expect(foreignScriptChars(`${HAN_CITY}${OBHOD}`, `the ${HAN_BEIJING} office`).sort()).toEqual(
      [...new Set(OBHOD)].sort(),
    );
  });

  // The leak ISS-962 exists to stop is untouched by the reversal: the source here is Latin-only, so
  // no Cyrillic is licensed and the homoglyph `а` in an otherwise Latin word is still named.
  it('still refuses a script the source never used at all', () => {
    expect(foreignScriptChars('deploy to m\u0430ster', ASCII_SOURCE)).toEqual(['\u0430']);
    expect(storableAgainstSource(CYRILLIC_LEAK, ASCII_SOURCE)).toBe(false);
  });
});

describe('foreignScriptChars — reporting', () => {
  it('reports each offending character once, however often it occurs', () => {
    expect(foreignScriptChars(`${OBHOD} ${OBHOD} ${OBHOD}`, ASCII_SOURCE)).toHaveLength(4);
  });

  it('reports a character outside the BMP as one code point', () => {
    expect(foreignScriptChars('\u{103a0}', ASCII_SOURCE)).toEqual(['\u{103a0}']);
  });
});
