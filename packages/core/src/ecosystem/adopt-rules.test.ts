import { describe, expect, it } from 'vitest';
import { type AdoptVersion, type AdoptWorld, checkAdopt } from './adopt-rules.js';
import type { ImpactChange, ImpactLink } from './contract/impact.js';

const CONTRACT = 'catalog-api/admin-rest-v1';

const version = (
  previous: string | null,
  classification: AdoptVersion['diff']['classification'],
  changes: ImpactChange[] = [],
  elements: string[] | null = null,
  approval = 'approved',
): AdoptVersion => ({
  approval,
  previous,
  diff: { classification, changes },
  elements: elements ? new Set(elements) : null,
});

const info = (element: string): ImpactChange => ({
  element,
  kind: 'added',
  level: 'info',
  text: `added ${element}`,
});

// the round-three shape: 3.0.0 pinned everywhere, 3.1.0 and 3.1.1 each measured additive
const VERSIONS = new Map<string, AdoptVersion>([
  ['3.0.0', version(null, 'initial', [], ['GET /products', 'GET /products/properties/name'])],
  ['3.1.0', version('3.0.0', 'non-breaking', [info('GET /products/properties/sku')])],
  [
    '3.1.1',
    version(
      '3.1.0',
      'non-breaking',
      [info('GET /orders')],
      ['GET /products', 'GET /products/properties/name', 'GET /orders'],
    ),
  ],
]);

const link = (id: string, over: Partial<ImpactLink> = {}): ImpactLink => ({
  id,
  consumer: 'catalog-fe',
  module: `src/${id}`,
  pinnedVersion: '3.0.0',
  callSites: [{ path: `src/${id}.ts`, line: 3, operation: 'GET /products' }],
  fieldsUsed: ['name'],
  outsideContract: [],
  ...over,
});

const world = (over: Partial<AdoptWorld> = {}): AdoptWorld => ({
  contract: CONTRACT,
  version: '3.1.1',
  versioning: 'semver',
  consumed: [{ index: 0, builtAgainst: '3.0.0' }],
  versions: VERSIONS,
  links: [link('l1'), link('l2')],
  ...over,
});

const codes = (w: AdoptWorld) => {
  const out = checkAdopt(w);
  return out.ok ? [] : out.refusals.map((r) => r.code);
};

describe('adopt: a consumer moves to an additive version in one act', () => {
  it('moves the consumption and every link pinned below the version', () => {
    const out = checkAdopt(world());
    expect(out).toEqual({
      ok: true,
      plan: {
        consumptions: [{ index: 0, from: '3.0.0' }],
        links: [
          { id: 'l1', module: 'src/l1', from: '3.0.0' },
          { id: 'l2', module: 'src/l2', from: '3.0.0' },
        ],
      },
    });
  });

  it('leaves what already pins the version where it is, and moves nothing twice', () => {
    const out = checkAdopt(
      world({
        consumed: [{ index: 0, builtAgainst: '3.1.1' }],
        links: [link('l1', { pinnedVersion: '3.1.1' }), link('l2', { pinnedVersion: '3.1.0' })],
      }),
    );
    expect(out.ok && out.plan).toEqual({
      consumptions: [],
      links: [{ id: 'l2', module: 'src/l2', from: '3.1.0' }],
    });
    const settled = checkAdopt(
      world({ consumed: [{ index: 0, builtAgainst: '3.1.1' }], links: [] }),
    );
    expect(settled.ok && settled.plan).toEqual({ consumptions: [], links: [] });
  });

  it('refuses a contract the interface does not consume, by name', () => {
    const out = checkAdopt(world({ consumed: [] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toEqual([
      expect.objectContaining({ code: 'ADOPT_CONTRACT_NOT_CONSUMED', path: '/contract' }),
    ]);
    expect(out.refusals[0]?.detail).toContain(CONTRACT);
  });

  it('refuses a version core never recorded or never approved', () => {
    expect(codes(world({ version: '9.9.9' }))).toEqual(['VERSION_UNKNOWN']);
    const proposed = new Map(VERSIONS).set(
      '3.2.0',
      version('3.1.1', 'non-breaking', [], null, 'proposed'),
    );
    expect(codes(world({ version: '3.2.0', versions: proposed }))).toEqual([
      'CONTRACT_VERSION_NOT_APPROVED',
    ]);
  });

  it('refuses a version behind any pin, naming the holder', () => {
    const out = checkAdopt(
      world({ version: '3.1.0', links: [link('l1', { pinnedVersion: '3.1.1' })] }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toEqual([
      expect.objectContaining({
        code: 'ADOPT_VERSION_BEHIND_PIN',
        path: '/links/l1/pinnedVersion',
      }),
    ]);
  });

  it('refuses a breaking version anywhere between the pin and the version', () => {
    const broke = new Map(VERSIONS).set(
      '3.1.0',
      version('3.0.0', 'breaking', [
        { element: 'GET /orders', kind: 'removed', level: 'breaking', text: 'removed GET /orders' },
      ]),
    );
    const out = checkAdopt(world({ versions: broke }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.code)).toEqual(['ADOPT_VERSION_BREAKING']);
    expect(out.refusals[0]?.detail).toContain('3.1.0');
  });

  it('refuses a step no differ measured as additive: unknown, a declared semantic change, or no line back to the pin', () => {
    const unknown = new Map(VERSIONS).set('3.1.0', version('3.0.0', 'unknown'));
    expect(codes(world({ versions: unknown }))).toEqual(['ADOPT_VERSION_UNMEASURED']);
    const unread = new Map(VERSIONS).set(
      '3.1.0',
      version('3.0.0', 'non-breaking', [
        { element: 'document', kind: 'changed', level: 'info', text: 'opaque', check: 'opaque' },
      ]),
    );
    expect(codes(world({ versions: unread }))).toEqual(['ADOPT_VERSION_UNMEASURED']);
    const cut = new Map(VERSIONS).set('3.1.0', version(null, 'non-breaking'));
    const out = checkAdopt(world({ versions: cut }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]).toMatchObject({
      code: 'ADOPT_VERSION_UNMEASURED',
      path: '/consumes/0/builtAgainst',
    });
  });

  it('refuses a link whose field a step removed, naming the link and the field', () => {
    const dropped = new Map(VERSIONS).set(
      '3.1.0',
      version('3.0.0', 'non-breaking', [
        {
          element: 'GET /products',
          kind: 'removed',
          level: 'info',
          text: "removed the optional property 'data/items/name' from the response",
          check: 'response-optional-property-removed',
        },
      ]),
    );
    const out = checkAdopt(
      world({ versions: dropped, links: [link('l1'), link('l2', { fieldsUsed: ['sku'] })] }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0]).toMatchObject({
      code: 'ADOPT_FIELD_MISSING',
      path: '/links/l1/fieldsUsed',
    });
    expect(out.refusals[0]?.detail).toContain('link l1 (src/l1) reads data.items.name');
  });

  it('refuses a link reading an element the pinned version indexes and the version does not', () => {
    const out = checkAdopt(
      world({ links: [link('l1', { fieldsUsed: ['GET /products/properties/name'] })] }),
    );
    expect(out.ok).toBe(true);
    const gone = new Map(VERSIONS).set(
      '3.1.1',
      version('3.1.0', 'non-breaking', [], ['GET /products', 'GET /orders']),
    );
    const refused = checkAdopt(
      world({
        versions: gone,
        links: [link('l1', { fieldsUsed: ['GET /products/properties/name'] })],
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals[0]).toMatchObject({ code: 'ADOPT_FIELD_MISSING' });
    expect(refused.refusals[0]?.detail).toContain('GET /products/properties/name');
  });
  it('refuses a step whose measured changes were cut to fit the record, since a removed field may be among the unlisted', () => {
    const cut = new Map(VERSIONS).set(
      '3.1.0',
      version('3.0.0', 'non-breaking', [
        info('GET /products/properties/sku'),
        {
          element: 'document',
          kind: 'changed',
          level: 'info',
          text: '12 further change(s) measured and not listed; the list holds 500.',
          check: 'changes-truncated',
        },
      ]),
    );
    const out = checkAdopt(world({ versions: cut }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]).toMatchObject({ code: 'ADOPT_VERSION_UNMEASURED' });
    expect(out.refusals[0]?.detail).toContain('than its record lists');
  });
});
