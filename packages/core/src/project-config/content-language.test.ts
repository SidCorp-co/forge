import { CONTENT_LANGUAGE_REFUSAL_CODES } from '@forge/contracts/content-language';
import { describe, expect, it } from 'vitest';
import { CONFIG_REFUSAL_CODES, checkContentLanguage } from './rules.js';

describe('checkContentLanguage', () => {
  it('takes a canonical tag, and a document that declares none', () => {
    expect(checkContentLanguage({ contentLanguage: 'vi' })).toEqual([]);
    expect(checkContentLanguage({})).toEqual([]);
  });

  it.each([
    ['vietnamese', 'a BCP-47 language tag'],
    ['pt-br', '"pt-BR"'],
  ])('CONTENT_LANGUAGE_INVALID at /contentLanguage for %j, naming what is valid', (tag, names) => {
    const out = checkContentLanguage({ contentLanguage: tag });
    expect(out.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'CONTENT_LANGUAGE_INVALID', path: '/contentLanguage' },
    ]);
    expect(out[0]?.detail).toContain(names);
  });

  it('its codes are in the config vocabulary the write answers with', () => {
    for (const code of CONTENT_LANGUAGE_REFUSAL_CODES) expect(CONFIG_REFUSAL_CODES).toContain(code);
  });
});
