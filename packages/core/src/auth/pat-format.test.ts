import { describe, expect, it } from 'vitest';
import {
  PAT_PATTERN,
  PAT_PREFIX_LEN,
  PAT_PREFIX_PATTERN,
  PAT_STRING_PATTERN,
  generatePatPlaintext,
  isPatLike,
  isPatValid,
  patEnvForNodeEnv,
  patPrefixOf,
} from './pat-format.js';

describe('PAT_PATTERN', () => {
  it.each([
    'forge_pat_dev_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'forge_pat_stg_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    'forge_pat_prd_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  ])('matches well-formed plaintext: %s', (token) => {
    expect(PAT_PATTERN.test(token)).toBe(true);
    expect(isPatValid(token)).toBe(true);
  });

  it.each([
    'forge_pat_xyz_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'forge_pat_dev_short',
    'forge_pat_dev_0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDE',
    'pat_dev_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    '',
  ])('rejects malformed: %s', (token) => {
    expect(PAT_PATTERN.test(token)).toBe(false);
    expect(isPatValid(token)).toBe(false);
  });
});

describe('PAT_PREFIX_PATTERN', () => {
  it('recognises PAT-shaped tokens for dispatcher routing', () => {
    expect(PAT_PREFIX_PATTERN.test('forge_pat_dev_abc')).toBe(true);
    expect(isPatLike('forge_pat_prd_xyz')).toBe(true);
    expect(isPatLike('device-token-base64url')).toBe(false);
  });
});

describe('generatePatPlaintext', () => {
  it('produces tokens that pass strict validation', () => {
    const token = generatePatPlaintext('dev');
    expect(isPatValid(token)).toBe(true);
    expect(patPrefixOf(token).length).toBe(PAT_PREFIX_LEN);
  });

  it('does not repeat across 100 invocations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generatePatPlaintext('prd'));
    expect(seen.size).toBe(100);
  });
});

describe('patEnvForNodeEnv', () => {
  it.each([
    ['production', 'prd'],
    ['staging', 'stg'],
    ['development', 'dev'],
    ['test', 'dev'],
  ])('%s → %s', (input, expected) => {
    expect(patEnvForNodeEnv(input)).toBe(expected);
  });
});

describe('PAT_STRING_PATTERN', () => {
  it('finds tokens embedded in larger strings', () => {
    const haystack =
      'oops {"token":"forge_pat_prd_abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234"} done';
    const m = haystack.match(PAT_STRING_PATTERN);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/^forge_pat_prd_/);
  });

  it('matches every env tag', () => {
    const dev = 'forge_pat_dev_aaaa';
    const stg = 'forge_pat_stg_bbbb';
    const prd = 'forge_pat_prd_cccc';
    const combined = `${dev} ${stg} ${prd}`;
    expect(combined.match(PAT_STRING_PATTERN)).toEqual([dev, stg, prd]);
  });
});
