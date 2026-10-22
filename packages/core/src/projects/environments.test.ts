// ISS-1069 — the one normaliser, and the one place an EMPTY deployment blob gets its meaning.
//
// Before this file there were three readers — `readPreviewDeploy`, the MCP `get` handler and
// `loadProjectFactInputs` — each picking keys out of the column by hand with `?? {}`. The cases
// below are the ones on which those three could have disagreed: a SQL null, a JSON null, an empty
// object, a value that is not an object at all, and a side whose fields are present but say
// nothing. Each is a different stored byte sequence and all of them are the same ANSWER.

import { describe, expect, it } from 'vitest';
import {
  credentialFaults,
  environmentsPatchSchema,
  normalizeEnvironments,
  refusedKeysIn,
  refusedKeysMessage,
} from './environments.js';

const EMPTY = {
  preview: null,
  live: { url: null, apiUrl: null },
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

  it('fills the other field for a live holding only a url', () => {
    expect(normalizeEnvironments({ live: { url: 'https://app.x' } }).live).toEqual({
      url: 'https://app.x',
      apiUrl: null,
    });
  });

  it('reads no retired commit endpoint, whatever a row still holds', () => {
    expect(
      normalizeEnvironments({
        live: { url: 'https://app.x', commitUrl: 'https://api.x/health', commitPath: 'commit' },
      }).live,
    ).toEqual({ url: 'https://app.x', apiUrl: null });
  });
});

describe('refusedKeysIn — a patch naming a key the document does not take', () => {
  const paths = (patch: Record<string, unknown>, stored: Record<string, unknown> = {}) =>
    refusedKeysIn(patch, stored).map((r) => `${r.why} ${r.path}`);

  it.each([
    [{ live: { commitUrl: 'https://api.x/health' } }, ['retired live.commitUrl']],
    [{ live: { commitUrl: null } }, ['retired live.commitUrl']],
    [{ live: { commitPath: null, url: 'https://app.x' } }, ['retired live.commitPath']],
    [
      { live: { commitUrl: null, commitPath: 'commit' } },
      ['retired live.commitUrl', 'retired live.commitPath'],
    ],
  ])('names the retired keys in %j, a null included', (patch, keys) => {
    expect(paths(patch)).toEqual(keys);
  });

  // ISS-1339 r3, judge-99: the dotted `live.commitUrl` was refused as an unknown key, without the
  // sentence that says where a probe is declared now.
  it.each([
    [{ 'live.commitUrl': 'https://x.example/v' }, ['retired live.commitUrl']],
    [{ 'environments.live.commitPath': 'sha' }, ['retired environments.live.commitPath']],
    [{ live: { commit_url: 'https://x.example/v' } }, ['retired live.commit_url']],
    [{ live: { commitURL: null } }, ['retired live.commitURL']],
    [{ 'Live.Commit-Path': 'sha' }, ['retired Live.Commit-Path']],
  ])('names a retired live field in another spelling in %j', (patch, keys) => {
    expect(paths(patch)).toEqual(keys);
  });

  it.each([
    [{ 'live.region': 'eu' }, ['unknown live.region']],
    [{ 'live.commitUrlish': 'x' }, ['unknown live.commitUrlish']],
    [{ 'preview.commitUrl': 'x' }, ['unknown preview.commitUrl']],
    [{ 'environments.live.commitUrl.x': 'y' }, ['unknown environments.live.commitUrl.x']],
    [{ futureKnob: 1, limits: 'x' }, ['unknown futureKnob']],
    [{ live: { url: 'https://app.x', region: 'eu' } }, ['unknown live.region']],
    [
      { preview: { url: 'https://p.x', commitUrl: 'https://p.x/v' } },
      ['unknown preview.commitUrl'],
    ],
    [{ futureKnob: null }, ['unknown futureKnob']],
  ])('names a key the document does not have in %j', (patch, keys) => {
    expect(paths(patch)).toEqual(keys);
  });

  it.each([
    [{ live: { url: 'https://app.x', apiUrl: null } }],
    [{ preview: { url: null, apiUrl: 'https://p.x', urls: [] } }],
    [{ preview: null, live: null }],
    [
      {
        testCredentials: [
          { label: 'a', username: 'u', password: 'p', note: 'rows keep what they carry' },
        ],
      },
    ],
    [{ limits: 'x' }],
    [{}],
  ])('names none in %j', (patch) => {
    expect(paths(patch)).toEqual([]);
  });

  it('lets a null delete a stray the stored document holds, and only that', () => {
    const stored = { futureKnob: 1, preview: { url: 'https://p.x', commitUrl: 'https://p.x/v' } };
    expect(paths({ futureKnob: null, preview: { commitUrl: null } }, stored)).toEqual([]);
    expect(paths({ futureKnob: 2 }, stored)).toEqual(['unknown futureKnob']);
    expect(paths({ preview: { commitUrl: 'https://p.x/v2' } }, stored)).toEqual([
      'unknown preview.commitUrl',
    ]);
    expect(paths({ otherKnob: null }, stored)).toEqual(['unknown otherKnob']);
  });

  it('refuses a retired live key sent as null even where it is stored', () => {
    expect(
      paths({ live: { commitUrl: null } }, { live: { commitUrl: 'https://api.x/v' } }),
    ).toEqual(['retired live.commitUrl']);
  });
});

describe('refusedKeysMessage — one refusal, each key named once', () => {
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('names both retired keys once, and says nothing was written once', () => {
    const said = refusedKeysMessage(
      refusedKeysIn({ live: { commitUrl: 'a', commitPath: 'b' } }, {}),
    );
    expect(count(said, 'environments.live.commitUrl')).toBe(1);
    expect(count(said, 'environments.live.commitPath')).toBe(1);
    expect(count(said, 'Nothing was written.')).toBe(1);
    expect(count(said, 'verify.probes')).toBe(1);
    expect(said).toContain('were retired');
  });

  it('names an unknown key by its path beside the valid shape', () => {
    const said = refusedKeysMessage(
      refusedKeysIn({ 'live.region': 'x', live: { healthUrl: 'eu' } }, {}),
    );
    expect(said).toContain(
      '`live.region` and `live.healthUrl` are not keys of the environments document',
    );
    expect(said).toContain(
      '{ preview: { url, apiUrl, urls[] } | null, live: { url, apiUrl }, testCredentials[], limits }',
    );
    expect(count(said, 'Nothing was written.')).toBe(1);
  });

  it('gives a dotted retired key the retirement sentence, naming the field once with its spelling', () => {
    const said = refusedKeysMessage(
      refusedKeysIn({ 'live.commitUrl': 'x', live: { commit_url: 'y', commitPath: 'z' } }, {}),
    );
    expect(said).toContain(
      '`environments.live.commitUrl` and `environments.live.commitPath` were retired',
    );
    expect(count(said, 'environments.live.commitUrl')).toBe(1);
    expect(count(said, 'commit_url')).toBe(0);
    expect(count(said, 'verify.probes')).toBe(1);
    expect(said).not.toContain('is not a key');
    expect(count(said, 'Nothing was written.')).toBe(1);
  });

  it('says how a retired field was spelled where it differs from the field', () => {
    expect(refusedKeysMessage(refusedKeysIn({ live: { commit_url: 'x' } }, {}))).toContain(
      '`environments.live.commitUrl` (sent as `live.commit_url`) was retired',
    );
    expect(refusedKeysMessage(refusedKeysIn({ 'environments.live.commitUrl': 'x' }, {}))).toContain(
      '`environments.live.commitUrl` was retired',
    );
  });

  // ISS-1421 r25, judge-102 (e): a retired field nested under the document's own name was "unknown".
  it.each([
    ['the document nested in itself', { environments: { live: { commitUrl: 'x' } } }],
    ['a dotted prefix holding an object', { 'environments.live': { commitUrl: 'x' } }],
    ['an unknown wrapper', { Environments: { live: { commit_url: 'x' } } }],
    ['an object for its value', { environments: { live: { commitUrl: { value: 'x' } } } }],
  ])('gives a retired field sent as %s the retirement sentence alone', (_name, patch) => {
    const said = refusedKeysMessage(refusedKeysIn(patch, {}));
    expect(said).toMatch(/^`environments\.live\.commitUrl`( \(sent as `[^`]+`\))? was retired/);
    expect(said).not.toContain('is not a key');
    expect(count(said, 'Nothing was written.')).toBe(1);
  });

  it('still names the wrapper unknown where it holds more than a retired field', () => {
    const said = refusedKeysMessage(
      refusedKeysIn({ environments: { live: { commitUrl: 'x', url: 'https://a.example' } } }, {}),
    );
    expect(said).toContain('was retired');
    expect(said).toContain('`environments` is not a key of the environments document');
  });

  it('says a retired key and an unknown one in one message', () => {
    const said = refusedKeysMessage(refusedKeysIn({ live: { commitUrl: 'x' }, futureKnob: 1 }, {}));
    expect(said).toContain('`environments.live.commitUrl` was retired');
    expect(said).toContain('`futureKnob` is not a key of the environments document');
    expect(count(said, 'Nothing was written.')).toBe(1);
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

describe('environmentsPatchSchema — null is a value for seven fields and for no other', () => {
  const NULLABLE: [string, unknown][] = [
    ['preview', { preview: null }],
    ['live', { live: null }],
    ['limits', { limits: null }],
    ['preview.url', { preview: { url: null } }],
    ['preview.apiUrl', { preview: { apiUrl: null } }],
    ['live.url', { live: { url: null } }],
    ['live.apiUrl', { live: { apiUrl: null } }],
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
  ];

  it.each(REFUSED_ENVIRONMENTS)('refuses %s', (_label, environments, names) => {
    const out = environmentsPatchSchema.safeParse(environments);
    expect(out.success).toBe(false);
    expect(out.error?.issues.flatMap((i) => i.path.map(String)).join('.')).toContain(names);
  });
});

describe('credentialFaults — a credential a write may not store', () => {
  const row = (label: string, username: string, password: string) => ({
    label,
    username,
    password,
  });

  it('names a row with no password, at its password', () => {
    expect(credentialFaults([row('QA', 'qa@example.com', '')])).toEqual([
      expect.objectContaining({ path: 'testCredentials.0.password', rule: 'password-required' }),
    ]);
  });

  it('counts a password of spaces as none', () => {
    expect(credentialFaults([row('QA', 'qa@example.com', '   ')]).map((f) => f.rule)).toEqual([
      'password-required',
    ]);
  });

  it('names the later of two rows sharing a label, whatever its case', () => {
    const faults = credentialFaults([
      row('QA', 'a@example.com', 'one'),
      row(' qa ', 'b@example.com', 'two'),
    ]);
    expect(faults).toEqual([
      expect.objectContaining({ path: 'testCredentials.1.label', rule: 'duplicate-label' }),
    ]);
    expect(faults[0]?.message).toMatch(
      /^testCredentials\[1\] \('qa'\) has the label testCredentials\[0\] \('QA'\) already has/,
    );
  });

  it('names one login listed twice under two labels', () => {
    expect(
      credentialFaults([
        row('Admin', 'qa@example.com', 's3cret'),
        row('Owner', 'QA@example.com', 's3cret'),
      ]),
    ).toEqual([
      expect.objectContaining({
        path: 'testCredentials.1.username',
        rule: 'duplicate-login',
        message: expect.stringMatching(
          /^testCredentials\[1\] \('Owner'\) is the same username and password as testCredentials\[0\] \('Admin'\)/,
        ),
      }),
    ]);
  });

  it('keeps one username with two passwords, which are two logins', () => {
    expect(
      credentialFaults([
        row('Preview admin', 'qa@example.com', 'one'),
        row('Live admin', 'qa@example.com', 'two'),
      ]),
    ).toEqual([]);
  });

  it('refuses nothing in a list of distinct logins, or in no list at all', () => {
    expect(credentialFaults([row('A', 'a', 'x'), row('B', 'b', 'y')])).toEqual([]);
    expect(credentialFaults(undefined)).toEqual([]);
  });
});
