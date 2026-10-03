import { describe, expect, it } from 'vitest';
import { owedTrigger } from './builder-head.js';
import {
  notOpenRefusal,
  type SupersederFacts,
  supersededRun,
  supersedeReason,
  supersederRefusal,
} from './builder-supersede-rules.js';
import { FP } from './ecosystem.fixture.js';
import {
  builderRunIdentityRefusals,
  checkBuilderRun,
  isOpenRun,
  openedRun,
  parseBuilderRun,
  stepsStale,
} from './link-rules.js';
import type { BuilderRunWrite } from './link-schema.js';

const PLUGIN = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';
const NEXT = '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const HEAD = '7e0c2a9d4b6f8e1a3c5d7f9b0a2c4e6d8f1b3a5c';
const repo = { type: 'repository' } as const;
const storefront = { type: 'storefront', provider: 'autoflow' } as const;

const opened = (source: typeof repo | typeof storefront = repo): BuilderRunWrite =>
  openedRun({
    ecosystem: FP,
    project: PLUGIN,
    trigger: { kind: 'joined', sha: HEAD },
    source,
  });

const codes = (raw: unknown) => {
  const parsed = parseBuilderRun(raw, PLUGIN);
  return parsed.ok ? [] : parsed.refusals.map((r) => `${r.code} ${r.path}`);
};

describe('the commit a joined or manual run names', () => {
  it("is the git project's default-branch head as its host reports it", async () => {
    const got = await owedTrigger({
      projectId: PLUGIN,
      kind: 'joined',
      source: repo,
      read: async () => HEAD,
    });
    expect(got).toEqual({ ok: true, value: { kind: 'joined', sha: HEAD } });
  });

  it('is no commit for a storefront project: sha null with source storefront, and no host is asked', async () => {
    const got = await owedTrigger({
      projectId: PLUGIN,
      kind: 'manual',
      source: storefront,
      read: async () => {
        throw new Error('a storefront run asked a host for a head');
      },
    });
    expect(got).toEqual({
      ok: true,
      value: { kind: 'manual', sha: null, source: 'storefront' },
    });
  });

  it('refuses the opening by name when the head cannot be read, and stores no stand-in', async () => {
    const unbound = await owedTrigger({
      projectId: PLUGIN,
      kind: 'joined',
      source: repo,
      read: async () => {
        throw new Error('this project has no active source host binding');
      },
    });
    expect(unbound.ok).toBe(false);
    if (unbound.ok) return;
    expect(unbound.refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
      'BUILDER_RUN_HEAD_UNREADABLE /trigger/sha',
    ]);
    expect(unbound.refusals[0]?.detail).toContain('no active source host binding');
    const junk = await owedTrigger({
      projectId: PLUGIN,
      kind: 'joined',
      source: repo,
      read: async () => 'main',
    });
    expect(junk.ok ? [] : junk.refusals.map((r) => r.code)).toEqual([
      'BUILDER_RUN_HEAD_UNREADABLE',
    ]);
  });

  it('keeps a stored trigger to a commit, or to no commit with source storefront, and nothing between', () => {
    const run = (trigger: unknown) => ({ ...opened(), trigger });
    expect(codes(run({ kind: 'manual', sha: HEAD }))).toEqual([]);
    expect(codes(run({ kind: 'joined', sha: null, source: 'storefront' }))).toEqual([]);
    expect(codes(run({ kind: 'joined', sha: null }))).toEqual(['SCHEMA_VIOLATION /trigger/sha']);
    expect(codes(run({ kind: 'joined', sha: HEAD, source: 'storefront' }))).toEqual([
      'SCHEMA_VIOLATION /trigger/sha',
    ]);
    expect(codes(run({ kind: 'rebuilt', sha: HEAD }))).toEqual([
      'BUILDER_TRIGGER_UNKNOWN /trigger/kind',
    ]);
  });
});

describe('who may supersede a run', () => {
  const facts = (over: Partial<SupersederFacts>): SupersederFacts => ({
    userId: 'u',
    agency: 'human',
    projectRole: null,
    projectOrgRole: null,
    stewardRole: null,
    ...over,
  });
  const allowed = (f: SupersederFacts) => supersederRefusal(f, PLUGIN) === null;

  it("takes the project's own master, and an org admin of the project's org or of the steward", () => {
    expect(allowed(facts({ agency: 'agent', projectRole: 'member' }))).toBe(true);
    expect(allowed(facts({ projectOrgRole: 'admin' }))).toBe(true);
    expect(allowed(facts({ stewardRole: 'owner' }))).toBe(true);
  });

  it("refuses another project's agent, even one in the steward's org, a project member who is no org admin, and a steward member, by name", () => {
    for (const f of [
      facts({ agency: 'agent', projectRole: null, projectOrgRole: 'member' }),
      facts({ agency: 'agent', projectRole: 'viewer' }),
      facts({ projectRole: 'admin', projectOrgRole: 'member' }),
      facts({ stewardRole: 'member' }),
      facts({ agency: 'agent', projectRole: null, stewardRole: 'owner' }),
    ]) {
      expect(supersederRefusal(f, PLUGIN)?.code).toBe('BUILDER_RUN_SUPERSEDE_NOT_AUTHORISED');
    }
  });
});

describe('superseding names why, and only an open run', () => {
  it('refuses a missing, empty or overlong reason by name', () => {
    for (const raw of [undefined, null, '', '   ', 42, 'x'.repeat(1001)]) {
      const got = supersedeReason(raw);
      expect(got.ok ? [] : got.refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
        'BUILDER_RUN_SUPERSEDE_WITHOUT_REASON /reason',
      ]);
    }
    expect(supersedeReason('  opened on the empty tree  ')).toEqual({
      ok: true,
      value: 'opened on the empty tree',
    });
  });

  it('refuses a finished run and an already superseded one by name, and takes an open one', () => {
    const open = opened();
    expect(notOpenRefusal('r', open)).toBeNull();
    const finished = {
      ...open,
      steps: open.steps.map((s) => ({ ...s, status: 'skipped' as const })),
    };
    expect(notOpenRefusal('r', finished)?.code).toBe('BUILDER_RUN_NOT_OPEN');
    const gone = supersededRun(open, { run: NEXT, reason: 'stale steps' });
    expect(notOpenRefusal('r', gone)?.code).toBe('BUILDER_RUN_NOT_OPEN');
  });
});

describe('a superseded run', () => {
  const open = opened();
  const progressed = {
    ...open,
    steps: open.steps.map((s, i) => (i === 0 ? { ...s, status: 'succeeded' as const } : s)),
  };
  const gone = supersededRun(progressed, { run: NEXT, reason: 'stale steps' });

  it('is closed: its finished steps kept, every unfinished one superseded, its replacement named', () => {
    expect(isOpenRun(gone)).toBe(false);
    expect(gone.steps.map((s) => s.status)).toEqual([
      'succeeded',
      ...open.steps.slice(1).map(() => 'superseded'),
    ]);
    expect(gone.supersededBy).toEqual({ run: NEXT, reason: 'stale steps' });
    expect(codes(gone)).toEqual([]);
  });

  it('refuses every later write by name, an unchanged one included', () => {
    for (const next of [gone, { ...gone, findings: [] }, progressed]) {
      expect(builderRunIdentityRefusals(gone, next).map((r) => r.code)).toEqual([
        'BUILDER_RUN_SUPERSEDED',
      ]);
    }
  });

  it('is never written by a document: superseded steps without supersededBy, or supersededBy on a write, are refused', () => {
    const marked = { ...open, steps: open.steps.map((s) => ({ ...s, status: 'superseded' })) };
    expect(codes(marked)).toEqual(['SCHEMA_VIOLATION /supersededBy']);
    expect(codes({ ...open, supersededBy: { run: NEXT, reason: 'x' } })).toEqual([
      'SCHEMA_VIOLATION /supersededBy',
    ]);
    expect(builderRunIdentityRefusals(open, gone).map((r) => `${r.code} ${r.path}`)).toEqual([
      'BUILDER_RUN_IMMUTABLE /supersededBy',
    ]);
    const world = {
      source: repo,
      projectActiveIn: new Set([FP]),
      published: new Set<string>(),
      links: new Set<string>(),
      openRun: null,
      creating: true,
    };
    expect(checkBuilderRun(gone, world).map((r) => r.code)).toEqual(['BUILDER_RUN_IMMUTABLE']);
  });
});

describe('a run whose steps its source no longer derives', () => {
  it('is stale when a storefront project holds the repository steps, and not when they match', () => {
    expect(stepsStale(opened(repo), storefront)).toBe(true);
    expect(stepsStale(opened(storefront), repo)).toBe(true);
    expect(stepsStale(opened(storefront), storefront)).toBe(false);
    expect(stepsStale(opened(repo), repo)).toBe(false);
  });
});
