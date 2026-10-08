// ISS-1383 r5 — a bound value is withheld however a sink re-encodes its text, at every length.

import { REDACTED, redactedMessage, redactQueryParams } from '@forge/observability';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { driverError, pgRefusal } from './query-params.fixture.js';

const STATEMENT = 'select $1::uuid';
const json = (text: string) => JSON.stringify(text).slice(1, -1);
const refusal = (v: string) => `invalid input syntax for type uuid: "${v}"`;

function failed(v: string): DrizzleQueryError {
  return new DrizzleQueryError(STATEMENT, [v], driverError(refusal(v), { code: '22P02' }));
}

/** A statement that bound nothing, as `select 1/0` fails through drizzle. */
function parameterless(): DrizzleQueryError {
  return new DrizzleQueryError(
    'select 1/0',
    [],
    driverError('division by zero', { code: '22012' }),
  );
}

/** A deferred constraint refused at COMMIT: postgres-js's own error, its `parameters` empty. */
function commitRefusal(): Error {
  return pgRefusal('duplicate key value violates unique constraint "d_u"', { code: '23505' }, []);
}

const SOURCES: [string, (v: string) => string][] = [
  ["drizzle's message", (v) => failed(v).message],
  ['the message as pino joins its cause', (v) => `${failed(v).message}: ${refusal(v)}`],
  ["the driver's refusal", refusal],
  ['a unique detail', (v) => `Key (email)=(${v}) already exists.`],
];

const ENCODINGS: [string, (text: string) => string][] = [
  ['raw', (t) => t],
  ['JSON-escaped once', json],
  ['JSON-escaped twice', (t) => json(json(t))],
  ['inside a template', (t) => `retry gave up after: ${t}`],
  ['escaped inside a template', (t) => `upstream said ${JSON.stringify({ m: t })}`],
];

const BESIDE: [string, (v: string) => unknown][] = [
  ['the error naming the value', (v) => failed(v)],
  ['no error', () => undefined],
  ['a parameterless failed query', () => [parameterless()]],
  ['a refusal at COMMIT', () => [commitRefusal()]],
  ['both', (v) => [parameterless(), failed(v)]],
];

/** mulberry32: the same values on every run, so a red names the value that made it. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...' "\'\\,:;-_.$()[]{}<>=@#%&*+/|?!~`',
  '\n',
  '\t',
  '\u00e9',
  '\u6f22',
];

/** Every way the value itself can be written: a leak in any of them is a leak. */
const forms = (v: string) => [...new Set([v, json(v), json(json(v))])];

/** The text every sink keeps whatever the value: a value hiding in it proves nothing. */
const SKELETON = [
  ...SOURCES.flatMap(([, source]) => ENCODINGS.map(([, encode]) => encode(source('')))),
  REDACTED,
  json(REDACTED),
  'retry gave up after: ',
].join('\u0001');

function values(count: number): string[] {
  const next = seeded(1383);
  const out: string[] = [];
  for (let n = 0; out.length < count; n++) {
    const length = 1 + (n % 64);
    const v = Array.from(
      { length },
      () => ALPHABET[Math.floor(next() * ALPHABET.length)] as string,
    ).join('');
    if (!forms(v).some((form) => SKELETON.includes(form))) out.push(v);
  }
  return out;
}

/** Each output as text with every marker taken out, so a value is not read inside one. */
function shown(out: unknown): string[] {
  const texts = [JSON.stringify(out)];
  if (typeof out === 'string') texts.push(out);
  return texts.map((t) => t.split(REDACTED).join('\u0001'));
}

describe('a bound value of any length, however its text is carried', () => {
  it('reaches no output of redactQueryParams or redactedMessage', () => {
    const leaks: string[] = [];
    const tried = values(320);
    for (const v of tried) {
      for (const [source, write] of SOURCES) {
        for (const [encoding, encode] of ENCODINGS) {
          const text = encode(write(v));
          for (const [beside, errors] of BESIDE) {
            const err = errors(v);
            const cause = Array.isArray(err) ? err.at(-1) : err;
            const outs = [
              redactQueryParams(text, err),
              redactQueryParams({ note: text }, err),
              redactedMessage(new Error(text, { cause })),
            ].flatMap(shown);
            if (forms(v).some((f) => outs.some((o) => o.includes(f)))) {
              leaks.push(`${JSON.stringify(v)} | ${source} | ${encoding} | beside ${beside}`);
            }
          }
        }
      }
    }
    expect(new Set(tried.map((v) => v.length)).size).toBe(64);
    expect(leaks).toEqual([]);
  });
});

describe('a bound value under six characters', () => {
  it('is withheld where it stands quoted or as the params, raw or escaped', () => {
    const err = failed('q9z');
    for (const text of [
      `lookup refused ${JSON.stringify({ m: refusal('q9z') })}`,
      'status was "q9z" when it failed',
      JSON.stringify(JSON.stringify(err.message)),
    ]) {
      expect(redactQueryParams(text, err)).not.toContain('q9z');
    }
  });

  it('is left in prose where it stands bare: the trade for not rewriting ordinary words', () => {
    const text = 'build q9z finished';
    expect(redactQueryParams(text, failed('q9z'))).toBe(text);
  });
});

describe('a failed query that bound nothing, beside one that bound values', () => {
  it('leaves text that only names params as it is, beside a statement that bound nothing', () => {
    expect(redactQueryParams('route params: id', [parameterless()])).toBe('route params: id');
  });

  it.each([
    ['a parameterless failed query', parameterless],
    ['a refusal at COMMIT', commitRefusal],
  ])('leaves no value of the other through %s', (_, make) => {
    const other = new DrizzleQueryError(
      'insert into t values ($1, $2)',
      ['sekrit1', 'sekrit1-hash'],
      driverError('x', { code: '23505' }),
    );
    expect(redactQueryParams(`retry gave up after: ${other.message}`, [make()])).toBe(
      `retry gave up after: Failed query: insert into t values ($1, $2)\nparams: ${REDACTED}`,
    );
  });

  it.each([
    [
      "begins another statement's list",
      'ab',
      'Failed query: select $1, $2\nparams: ab,cd-other-statement',
    ],
    [
      'ends at a line break another value runs on past',
      'known1',
      'Failed query: select $1\nparams: known1\nprivate-tail',
    ],
    [
      'opens with a short value quoted',
      'q9z',
      'Failed query: select $1, $2\nparams: "q9z",unrelated-secret',
    ],
    [
      'is followed by text another value holds',
      'abcdefgh',
      `${failed('abcdefgh').message}: private-tail`,
    ],
    [
      'quotes a short value right after an anchor, other text after it',
      'q9z',
      'malformed array literal: "q9z"private-tail',
    ],
    [
      'quotes a short value in another refusal, other text after it',
      'q9z',
      'invalid input value for enum mood: "q9z", then private-tail',
    ],
  ])('redacts to the end where the error in hand %s', (_, v, text) => {
    for (const t of [text, json(text), json(json(text))]) {
      const out = redactQueryParams(t, failed(v));
      expect(out.slice(0, 12)).toBe(t.slice(0, 12));
      expect(out).toContain(REDACTED);
      expect(out).not.toMatch(/cd-other|private-tail|unrelated-secret/);
    }
  });
});
