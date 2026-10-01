import { describe, expect, it } from 'vitest';
import { type Doc, emittedAccepts, example, FP } from './ecosystem.fixture.js';
import {
  checkLink,
  type LinkWorld,
  linkIdentityRefusals,
  parseLink,
  writerRefusal,
} from './link-rules.js';
import { LIMITS, type LinkWrite } from './link-schema.js';
import type { InterfaceDocument } from './schema.js';

const FORGE = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
const PLUGIN = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';
const OTHER_ECO = '6d2a1b4f-8c3e-4f9b-8a21-3b4c5d6e7f81';

const record = (): Doc => example('forge-plugin.link.json');

function written(): Doc {
  const d = record();
  delete d.id;
  delete d.createdAt;
  delete d.updatedAt;
  return d;
}

const world = (over: Partial<LinkWorld> = {}): LinkWorld => ({
  consumerActiveIn: new Set([FP]),
  provider: {
    id: FORGE,
    activeIn: new Set([FP]),
    interface: example('forge.interface.json') as InterfaceDocument,
  },
  versions: new Set(['2026-09-20', '2026-10-01']),
  duplicateOf: null,
  ...over,
});

function refusalsOf(raw: Doc, w: LinkWorld = world()) {
  const parsed = parseLink(raw, PLUGIN);
  return parsed.ok ? checkLink(parsed.value, w) : parsed.refusals;
}

const codesAt = (raw: Doc, w?: LinkWorld) => refusalsOf(raw, w).map((r) => `${r.code} ${r.path}`);

const withDoc = (patch: (d: Doc) => void) => {
  const d = written();
  patch(d);
  return d;
};

describe('a link the consumer writes', () => {
  it('is accepted whole, and the record it becomes is accepted by the emitted schema', () => {
    expect(refusalsOf(written())).toEqual([]);
    expect(emittedAccepts(record())).toBe(true);
  });

  it('may be still building with no call site and every list empty', () => {
    const d = withDoc((x) => {
      x.state = 'building';
      x.callSites = [];
      x.fieldsUsed = [];
      x.outsideContract = [];
      x.notes = [];
      x.writtenBy = { sha: x.writtenBy.sha };
    });
    expect(refusalsOf(d)).toEqual([]);
  });

  it('holds every list at its bound and refuses one past it', () => {
    const site = { path: 'a/b.ts', line: 1, operation: 'GET /x' };
    const at = withDoc((x) => {
      x.callSites = Array.from({ length: LIMITS.callSites }, (_, i) => ({ ...site, line: i + 1 }));
      x.notes = Array.from({ length: LIMITS.notes }, () => 'n'.repeat(LIMITS.note));
      x.fieldsUsed = Array.from({ length: LIMITS.fieldsUsed }, (_, i) => `f${i}`);
      x.outsideContract = Array.from({ length: LIMITS.outsideContract }, (_, i) => `op ${i}`);
      x.consumer.module = 'm'.repeat(LIMITS.path);
    });
    expect(refusalsOf(at)).toEqual([]);
    const past = structuredClone(at);
    past.callSites.push(site);
    past.notes.push('n');
    past.notes[0] = 'n'.repeat(LIMITS.note + 1);
    past.fieldsUsed.push('extra');
    past.outsideContract.push('extra');
    past.consumer.module = 'm'.repeat(LIMITS.path + 1);
    expect(codesAt(past).sort()).toEqual(
      [
        'SCHEMA_VIOLATION /callSites',
        'SCHEMA_VIOLATION /consumer/module',
        'SCHEMA_VIOLATION /fieldsUsed',
        'SCHEMA_VIOLATION /notes',
        'SCHEMA_VIOLATION /notes/0',
        'SCHEMA_VIOLATION /outsideContract',
      ].sort(),
    );
  });
});

const plants: [string, () => Doc, LinkWorld, string][] = [
  [
    'an absolute call site path',
    () => withDoc((d) => (d.callSites[0].path = '/etc/passwd')),
    world(),
    'PATH_OUTSIDE_REPO /callSites/0/path',
  ],
  [
    'a call site path that climbs out of the repo',
    () => withDoc((d) => (d.callSites[1].path = 'cli/../../secrets.env')),
    world(),
    'PATH_OUTSIDE_REPO /callSites/1/path',
  ],
  [
    'a module path that climbs out of the repo',
    () => withDoc((d) => (d.consumer.module = '../sibling')),
    world(),
    'PATH_OUTSIDE_REPO /consumer/module',
  ],
  [
    'a drive-rooted path',
    () => withDoc((d) => (d.callSites[0].path = 'C:/src/a.ts')),
    world(),
    'PATH_OUTSIDE_REPO /callSites/0/path',
  ],
  [
    'a path with a dot segment',
    () => withDoc((d) => (d.callSites[0].path = './cli/a.ts')),
    world(),
    'PATH_OUTSIDE_REPO /callSites/0/path',
  ],
  [
    'a pinned version the provider never recorded',
    () => withDoc((d) => (d.pinnedVersion = '2025-01-01')),
    world(),
    'VERSION_UNKNOWN /pinnedVersion',
  ],
  [
    'a state outside the enum',
    () => withDoc((d) => (d.state = 'stale')),
    world(),
    'LINK_STATE_UNKNOWN /state',
  ],
  [
    'a guide with no call site that is not building',
    () => withDoc((d) => (d.callSites = [])),
    world(),
    'LINK_GUIDE_WITHOUT_CALL_SITE /callSites',
  ],
  [
    'a second link for the same module and contract',
    written,
    world({ duplicateOf: 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01' }),
    'LINK_DUPLICATE /consumer/module',
  ],
  [
    'a provider that is not an active member',
    written,
    world({
      provider: { id: FORGE, activeIn: new Set([OTHER_ECO]), interface: null },
    }),
    'LINK_PROVIDER_NOT_MEMBER /contract/provider',
  ],
  [
    'a consumer that is not an active member',
    written,
    world({ consumerActiveIn: new Set() }),
    'LINK_CONSUMER_NOT_MEMBER /ecosystem',
  ],
  [
    'a contract its provider does not publish',
    () => withDoc((d) => (d.contract.slug = 'runner')),
    world(),
    'REF_NOT_PUBLISHED /contract/slug',
  ],
  [
    'a provider that does not exist',
    written,
    world({ provider: null }),
    'REF_UNRESOLVED /contract/provider',
  ],
  [
    'a link to its own contract',
    () => withDoc((d) => (d.contract.provider = PLUGIN)),
    world(),
    'SELF_CONSUMPTION /contract/provider',
  ],
  [
    'a link naming another consumer',
    () => withDoc((d) => (d.consumer.project = FORGE)),
    world(),
    'PROJECT_ID_IMMUTABLE /consumer/project',
  ],
  [
    'a write that sets the id core assigns',
    () => ({ ...written(), id: 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01' }),
    world(),
    'UNKNOWN_KEY /id',
  ],
];

describe('every planted link is refused by its own code, and by nothing that passes it', () => {
  it.each(plants)('%s', (_name, build, w, expected) => {
    expect(codesAt(build(), w)).toEqual([expected]);
  });

  const shapeOnly = plants.filter(([, , , e]) =>
    /^(PATH_OUTSIDE_REPO|LINK_STATE_UNKNOWN) /.test(e),
  );
  it.each(shapeOnly)('the emitted schema refuses %s too', (_name, build) => {
    expect(emittedAccepts({ ...record(), ...build() })).toBe(false);
  });

  it('names both sides when neither is a member', () => {
    const w = world({
      consumerActiveIn: new Set(),
      provider: { id: FORGE, activeIn: new Set(), interface: null },
    });
    expect(codesAt(written(), w)).toEqual([
      'LINK_CONSUMER_NOT_MEMBER /ecosystem',
      'LINK_PROVIDER_NOT_MEMBER /contract/provider',
    ]);
  });

  it('keeps a long path a length violation, not a path refusal', () => {
    const d = withDoc((x) => (x.callSites[0].path = 'a'.repeat(LIMITS.path + 1)));
    expect(codesAt(d)).toEqual(['SCHEMA_VIOLATION /callSites/0/path']);
  });

  it('accepts a dotted name that does not climb', () => {
    const d = withDoc((x) => {
      x.callSites[0].path = '.github/workflows/a..b.yml';
      x.consumer.module = 'src/[id]';
    });
    expect(refusalsOf(d)).toEqual([]);
  });
});

describe('who writes a link', () => {
  const at = (agency: 'agent' | 'human', role: 'viewer' | 'member' | 'admin' | null) =>
    writerRefusal({ userId: 'u', agency, role }, PLUGIN, 'LINK_WRITER_NOT_CONSUMER')?.code ?? null;

  it("is the consumer's own agent at member or above", () => {
    expect(at('agent', 'member')).toBeNull();
    expect(at('agent', 'admin')).toBeNull();
  });

  it('is never a person, a viewer agent or an agent with no role on the consumer', () => {
    expect(at('human', 'admin')).toBe('LINK_WRITER_NOT_CONSUMER');
    expect(at('agent', 'viewer')).toBe('LINK_WRITER_NOT_CONSUMER');
    expect(at('agent', null)).toBe('LINK_WRITER_NOT_CONSUMER');
  });
});

describe('a refreshed link keeps what it joins', () => {
  const doc = () => parseLink(written(), PLUGIN);
  const stored = () => {
    const p = doc();
    if (!p.ok) throw new Error('the fixture link does not parse');
    return p.value;
  };

  it('accepts a new state, pin and guide on the same identity', () => {
    const next: LinkWrite = { ...stored(), state: 'behind', pinnedVersion: '2026-10-01' };
    expect(linkIdentityRefusals(stored(), next)).toEqual([]);
  });

  it('refuses a moved module, contract or ecosystem by name', () => {
    const s = stored();
    const next: LinkWrite = {
      ...s,
      ecosystem: OTHER_ECO,
      consumer: { ...s.consumer, module: 'cli/other' },
      contract: { ...s.contract, slug: 'forge-mcp' },
    };
    expect(linkIdentityRefusals(s, next).map((r) => `${r.code} ${r.path}`)).toEqual([
      'LINK_IDENTITY_IMMUTABLE /ecosystem',
      'LINK_IDENTITY_IMMUTABLE /consumer/module',
      'LINK_IDENTITY_IMMUTABLE /contract',
    ]);
  });
});
