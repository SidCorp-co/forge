// ISS-1069 — the one normaliser, and the one place an EMPTY deployment blob gets its meaning.
//
// Before this file there were three readers — `readPreviewDeploy`, the MCP `get` handler and
// `loadProjectFactInputs` — each picking keys out of the column by hand with `?? {}`. The cases
// below are the ones on which those three could have disagreed: a SQL null, a JSON null, an empty
// object, a value that is not an object at all, and a side whose fields are present but say
// nothing. Each is a different stored byte sequence and all of them are the same ANSWER.

import { describe, expect, it } from 'vitest';
import { environmentsPatchSchema, normalizeEnvironments } from './environments.js';

const EMPTY = {
  preview: null,
  live: { url: null, apiUrl: null, commitUrl: null, commitPath: null },
  testCredentials: [],
  limits: null,
};

describe('normalizeEnvironments — what a column that says nothing means', () => {
  it.each([
    ['SQL null', null],
    ['undefined', undefined],
    ['JSON null', null],
    ['an empty object', {}],
    ['an array', []],
    ['a string', 'previewDeploy'],
    ['a number', 7],
  ])('answers the full empty shape for %s', (_label, stored) => {
    expect(normalizeEnvironments(stored)).toEqual(EMPTY);
  });
});

describe('normalizeEnvironments — the preview side', () => {
  it.each([
    ['absent', {}],
    ['JSON null', { preview: null }],
    ['an empty object', { preview: {} }],
    ['an array', { preview: [] }],
    ['all three fields empty', { preview: { url: null, apiUrl: null, urls: [] } }],
    ['an empty-string url', { preview: { url: '' } }],
  ])('answers preview: null for a stored preview that is %s', (_label, stored) => {
    expect(normalizeEnvironments(stored).preview).toBeNull();
  });

  it('fills the other two fields for a preview holding only a url', () => {
    expect(normalizeEnvironments({ preview: { url: 'https://stg.x' } }).preview).toEqual({
      url: 'https://stg.x',
      apiUrl: null,
      urls: [],
    });
  });

  it('is not null when only the urls list says something', () => {
    expect(
      normalizeEnvironments({ preview: { urls: [{ label: 'Beta', url: 'https://beta.x' }] } })
        .preview,
    ).toEqual({ url: null, apiUrl: null, urls: [{ label: 'Beta', url: 'https://beta.x' }] });
  });
});

describe('normalizeEnvironments — the live side', () => {
  it.each([
    ['absent', {}],
    ['JSON null', { live: null }],
    ['an empty object', { live: {} }],
    ['a string', { live: 'https://app.x' }],
  ])('answers the all-null live object for a stored live that is %s', (_label, stored) => {
    expect(normalizeEnvironments(stored).live).toEqual(EMPTY.live);
  });

  it('fills the other three fields for a live holding only a url', () => {
    expect(normalizeEnvironments({ live: { url: 'https://app.x' } }).live).toEqual({
      url: 'https://app.x',
      apiUrl: null,
      commitUrl: null,
      commitPath: null,
    });
  });

  it('answers commitUrl and commitPath separately from url', () => {
    expect(
      normalizeEnvironments({
        live: {
          url: 'https://app.x',
          commitUrl: 'https://api.x/health',
          commitPath: 'data.commit',
        },
      }).live,
    ).toEqual({
      url: 'https://app.x',
      apiUrl: null,
      commitUrl: 'https://api.x/health',
      commitPath: 'data.commit',
    });
  });
});

describe('normalizeEnvironments — a READING, not the stored value', () => {
  it('drops a key the schema does not name', () => {
    const out = normalizeEnvironments({ futureKnob: 'x', limits: 'y' });
    expect(out).not.toHaveProperty('futureKnob');
    expect(Object.keys(out).sort()).toEqual(['limits', 'live', 'preview', 'testCredentials']);
  });

  it('coerces credential rows to the three fields it names', () => {
    expect(
      normalizeEnvironments({
        testCredentials: [{ label: 'Admin', username: 'u', password: 'p', extra: 'e' }, 'nonsense'],
      }).testCredentials,
    ).toEqual([{ label: 'Admin', username: 'u', password: 'p' }]);
  });
});

describe('environmentsPatchSchema — null is a value for nine fields and for no other', () => {
  const NULLABLE: [string, unknown][] = [
    ['preview', { preview: null }],
    ['live', { live: null }],
    ['limits', { limits: null }],
    ['live.commitPath', { live: { commitPath: null } }],
    ['preview.url', { preview: { url: null } }],
    ['preview.apiUrl', { preview: { apiUrl: null } }],
    ['live.url', { live: { url: null } }],
    ['live.apiUrl', { live: { apiUrl: null } }],
    ['live.commitUrl', { live: { commitUrl: null } }],
  ];

  it.each(NULLABLE)('accepts a JSON null at %s', (_label, value) => {
    expect(environmentsPatchSchema.safeParse(value).success).toBe(true);
  });

  const NOT_NULLABLE: [string, unknown][] = [
    ['preview.urls', { preview: { urls: null } }],
    ['testCredentials', { testCredentials: null }],
    ['a row label', { preview: { urls: [{ label: null, url: 'https://x.example.com' }] } }],
    ['a row url', { preview: { urls: [{ label: 'X', url: null }] } }],
    ['a credential label', { testCredentials: [{ label: null, username: 'u', password: 'p' }] }],
    ['a credential username', { testCredentials: [{ label: 'A', username: null, password: 'p' }] }],
    ['a credential password', { testCredentials: [{ label: 'A', username: 'u', password: null }] }],
  ];

  it.each(NOT_NULLABLE)('refuses a JSON null at %s', (_label, value) => {
    expect(environmentsPatchSchema.safeParse(value).success).toBe(false);
  });
});

describe('environmentsPatchSchema — the catchall, at every level', () => {
  it('passes an unknown key through at the top level, inside a side, and inside a row', () => {
    const parsed = environmentsPatchSchema.parse({
      topKnob: 't',
      preview: {
        url: 'https://stg.x',
        previewKnob: 'p',
        urls: [{ label: 'B', url: 'https://b.x', rowKnob: 'r' }],
      },
      live: { url: 'https://app.x', liveKnob: 'l' },
      testCredentials: [{ label: 'A', username: 'u', password: 'p', credKnob: 'c' }],
    }) as unknown as {
      topKnob: unknown;
      preview: { previewKnob: unknown; urls: Record<string, unknown>[] };
      live: { liveKnob: unknown };
      testCredentials: Record<string, unknown>[];
    };
    expect(parsed.topKnob).toBe('t');
    expect(parsed.preview.previewKnob).toBe('p');
    expect(parsed.preview.urls[0]?.rowKnob).toBe('r');
    expect(parsed.live.liveKnob).toBe('l');
    expect(parsed.testCredentials[0]?.credKnob).toBe('c');
  });
});

// The value rules the environments document holds, asserted on the schema that holds them.
// They were route tests on `PATCH /api/projects/:id` until that door stopped taking this
// document at all; the door itself is asserted in `routes.test.ts`, and the write contract
// over the new one in `tests/integration/settings-write-contract-e2e.test.ts` (ISS-1170).
describe('environmentsPatchSchema — the values it refuses, and the field each refusal names', () => {
  const REFUSED_ENVIRONMENTS: [string, Record<string, unknown>, string][] = [
    ['a preview.url that is not a URL', { preview: { url: 'nope' } }, 'preview'],
    ['a preview.apiUrl that is not a URL', { preview: { apiUrl: 'nope' } }, 'apiUrl'],
    ['a live.url that is not a URL', { live: { url: 'nope' } }, 'live'],
    ['a live.apiUrl that is not a URL', { live: { apiUrl: 'nope' } }, 'apiUrl'],
    ['a live.commitUrl that is not a URL', { live: { commitUrl: 'nope' } }, 'commitUrl'],
    [
      'a preview.urls row missing its label',
      { preview: { urls: [{ url: 'https://x.example.com' }] } },
      'label',
    ],
    ['a preview.urls row missing its url', { preview: { urls: [{ label: 'X' }] } }, 'url'],
    [
      'a preview.urls row whose label is whitespace only',
      { preview: { urls: [{ label: '   ', url: 'https://x.example.com' }] } },
      'label',
    ],
    [
      'a testCredentials row missing its label',
      { testCredentials: [{ username: 'u', password: 'p' }] },
      'label',
    ],
    [
      'a testCredentials row missing its username',
      { testCredentials: [{ label: 'A', password: 'p' }] },
      'username',
    ],
    [
      'a testCredentials row missing its password',
      { testCredentials: [{ label: 'A', username: 'u' }] },
      'password',
    ],
    [
      'a testCredentials row whose username is not a string',
      { testCredentials: [{ label: 'A', username: 7, password: 'p' }] },
      'username',
    ],
    [
      'more than 50 preview.urls rows',
      {
        preview: {
          urls: Array.from({ length: 51 }, (_, i) => ({
            label: `L${i}`,
            url: 'https://x.example.com',
          })),
        },
      },
      'urls',
    ],
    [
      'more than 50 testCredentials rows',
      {
        testCredentials: Array.from({ length: 51 }, (_, i) => ({
          label: `L${i}`,
          username: 'u',
          password: 'p',
        })),
      },
      'testCredentials',
    ],
    ['a limits longer than 8000 characters', { limits: 'x'.repeat(8001) }, 'limits'],
    [
      'a commitPath longer than 200 characters',
      { live: { commitPath: 'x'.repeat(201) } },
      'commitPath',
    ],
  ];

  it.each(REFUSED_ENVIRONMENTS)('refuses %s', (_label, environments, names) => {
    const out = environmentsPatchSchema.safeParse(environments);
    expect(out.success).toBe(false);
    expect(out.error?.issues.flatMap((i) => i.path.map(String)).join('.')).toContain(names);
  });
});
