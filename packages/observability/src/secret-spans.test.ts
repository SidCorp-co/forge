// ISS-614 (FB-204): a provider key is read from its prefix only where the prefix starts a token, so
// the tail of a word ending in `sk` (task-, desk-, risk-) is not an OpenAI key; and the detector
// names the span it read, so a refusal can say where without echoing the secret back.

import { describe, expect, it } from 'vitest';
import { containsSecret, FILTERED, scrubLogText, secretSpans } from './index.js';

const ALNUM = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const body = (n: number) => ALNUM.repeat(Math.ceil(n / ALNUM.length)).slice(0, n);

// Built here rather than written out, so no tracked file carries a whole key-shaped literal.
const KEYS: readonly [string, string, string][] = [
  ['an OpenAI legacy key', `sk-${body(48)}`, 'sk-'],
  ['an OpenAI project key', `sk-proj-${body(40)}_${body(20)}-${body(10)}`, 'sk-proj-'],
  ['an OpenAI service-account key', `sk-svcacct-${body(60)}`, 'sk-svcacct-'],
  ['an OpenAI admin key', `sk-admin-${body(60)}`, 'sk-admin-'],
  ['an Anthropic key', `sk-ant-api03-${body(80)}-${body(6)}AA`, 'sk-ant-'],
  ['a short sk- key at its floor', `sk-${body(20)}`, 'sk-'],
  ['a webhook signing secret', `whsec_${body(32)}`, 'whsec_'],
  ['a GitHub token', `ghp_${body(36)}`, 'ghp_'],
  ['a GitHub fine-grained token', `github_pat_${body(22)}_${body(59)}`, 'github_pat_'],
];

const IDS = [
  'task-0b4523e70795a679f6ca7c3d',
  'desk-0b4523e70795a679f6ca7c3d',
  'risk-7dc311765850e2253a54cb1b',
  'case-90dd84c29657d4436bc176c0',
  'task-proj-roadmap-planning-2026',
  'task-ant-colony-migration-plan',
  'disk-0b4523e70795a679f6ca7c3d0b4523e70795a679',
];

describe('a provider key is read only where its prefix starts a token', () => {
  it.each(IDS)('admits the record id %s', (id) => {
    const text = `seen on the record ${id} in the batch`;
    expect(scrubLogText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
    expect(secretSpans(text)).toEqual([]);
  });

  it.each(KEYS)('still refuses %s, alone and after a separator', (_name, key) => {
    for (const before of ['', ' ', 'key=', 'key: ', '"', '(', '/', '_', 'x-', 'Bearer ']) {
      const text = `${before}${key} trailing`;
      expect(containsSecret(text)).toBe(true);
      expect(scrubLogText(text)).not.toContain(key.slice(-12));
    }
  });

  it('still refuses a long key glued to the word before it', () => {
    for (const [, key] of KEYS.filter(([, k]) => k.length >= 51)) {
      const text = `the apikey${key} leaked`;
      expect(containsSecret(text)).toBe(true);
      expect(scrubLogText(text)).toBe(`the apikey${FILTERED} leaked`);
    }
  });

  it('admits a hex id glued to a word, which is no longer than a sha', () => {
    const text = `ref tasksk-${'0b4523e70795a679f6ca7c3d'}${'0123456789abcdef'}`;
    expect(containsSecret(text)).toBe(false);
  });
});

describe('the detector names the span it read', () => {
  it('names the offsets of a key and its public prefix, never its secret part', () => {
    const key = `sk-proj-${body(60)}`;
    const text = `the judge saw ${key} in the log`;
    const [span, ...rest] = secretSpans(text);
    expect(rest).toEqual([]);
    expect(span).toEqual({ start: 14, end: 14 + key.length, shape: 'provider key', lead: 'sk-proj-' });
    expect(text.slice(span?.start, span?.end)).toBe(key);
  });

  it('names only the value where the scrubber keeps a label before it', () => {
    const text = 'Authorization: Bearer s3cretvalue1';
    const spans = secretSpans(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(['Bearer s3cretvalue1']);
    expect(spans[0]).toMatchObject({ shape: 'credential field', lead: '' });
  });

  it('names a connection password without the user, host or @', () => {
    const text = 'db at postgres://forge:hunter22@db.internal:5432/forge';
    const [span] = secretSpans(text);
    expect(span && text.slice(span.start, span.end)).toBe('hunter22');
    expect(span?.shape).toBe('connection password');
  });

  it('counts offsets across lines', () => {
    const key = `ghp_${body(36)}`;
    const text = `first line\nsecond ${key}`;
    const [span] = secretSpans(text);
    expect(span?.start).toBe(text.indexOf(key));
    expect(span?.lead).toBe('ghp_');
  });

  it('reads a label whose value was cut off as a span of the label', () => {
    const text = 'the form sends password: ';
    expect(secretSpans(text)).toEqual([
      { start: 15, end: 24, shape: 'secret label', lead: 'password:' },
    ]);
  });

  it('reads nothing in text the scrubber already redacted', () => {
    expect(secretSpans(`token=${FILTERED} and Bearer ${FILTERED}`)).toEqual([]);
  });

  // The spans and the redactor read one set of patterns: wherever the scrubber changes a line, a
  // span is named, and wherever it leaves one alone, none is.
  it.each([
    ...KEYS.map(([, k]) => `x ${k} y`),
    ...IDS,
    'Authorization: abc',
    'see ?token=abc123&id=7',
    `jwt eyJ${body(20)}.${body(20)}.${body(20)}`,
    'forge_pat_dev_0123456789abcdef',
    `ya29.${body(30)}`,
    'export DATABASE_PASSWORD = hunter2',
    `fw_sess_${body(12)}`,
    'plain prose about a Bearer credential',
  ])('agrees with the scrubber on %s', (text) => {
    expect(secretSpans(text).length > 0).toBe(scrubLogText(text) !== text);
  });
});
