// Two questions the batch used to answer for everybody the same way: what does
// this project's release actually consist of, and which box is allowed to run
// it. Both are per project, and both used to be hardcoded.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:why `knowledge/service.js` reaches `embeddings/index.js`, which validates the whole
// environment at import. This file reads the knowledge store and never embeds anything, so
// it mocks env rather than declaring three secrets it has no use for.
vi.mock('../config/env.js', () => ({ env: {} }));

// Since ISS-1048 the release procedure is a knowledge entry rather than an `agentConfig` key, so
// the fixture is a row from that store and the mock sits at the service seam.
type Entry = { body: string; archivedAt: Date | null } | null;
const knowledgeEntry = vi.fn(async (_id: string, _slug: string): Promise<Entry> => null);
vi.mock('../knowledge/service.js', () => ({
  getKnowledgeEntry: (id: string, slug: string) => knowledgeEntry(id, slug),
}));

const listBindings = vi.fn(async () => [] as unknown[]);
const dbExecute = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...a: unknown[]) => dbExecute(...a),
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));

vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const {
  classifyRollback,
  ReleaseRunnerAmbiguousError,
  releaseRunnerLabelOf,
  resolveReleaseChannels,
  resolveReleaseDeviceIds,
  resolveReleasePlan,
} = await import('./channel.js');

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function binding(over: {
  provider?: string;
  instructions?: string | null;
  bindingConfig?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  label?: string;
}) {
  return {
    binding: {
      id: over.provider === 'epodsystem' ? 'b-epod' : 'b-coolify',
      provider: over.provider ?? 'coolify',
      instructions: over.instructions ?? null,
      config: over.bindingConfig ?? {},
      label: over.label ?? '',
      role: 'deploy' as const,
      stages: ['live'] as const,
    },
    connection: { config: over.connectionConfig ?? {} },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
  dbExecute.mockResolvedValue([]);
});

describe('resolveReleaseChannels', () => {
  it('reports an empty set when the project declares no live deploy binding', async () => {
    expect(await resolveReleaseChannels(PROJECT_ID)).toEqual([]);
  });

  it('carries the operator text through verbatim', async () => {
    listBindings.mockResolvedValue([
      binding({ provider: 'coolify', instructions: 'ship the frontend WITH varnish' }),
    ]);

    const channels = await resolveReleaseChannels(PROJECT_ID);

    expect(channels).toHaveLength(1);
    expect(channels[0]?.provider).toBe('coolify');
    expect(channels[0]?.instructions).toBe('ship the frontend WITH varnish');
  });

  // cm:guard the SET, not its first member. This is the defect the whole change is named for: the
  // previous shape took `bindings[0]` off a query ordered `created_at ASC`, so on getcontent the
  // release agent was handed the Rocket.Chat room because it was created before the storefront, and
  // on the archived dodgeprint-api it was handed a Sentry project. A uniqueness constraint would not
  // have fixed that — the fault was core choosing at all.
  it('returns every live deploy binding with its own instructions, in order', async () => {
    listBindings.mockResolvedValue([
      binding({ provider: 'coolify', instructions: 'deploy the app' }),
      binding({ provider: 'epodsystem', instructions: 'publish the theme' }),
    ]);

    const channels = await resolveReleaseChannels(PROJECT_ID);

    expect(channels.map((c) => c.provider)).toEqual(['coolify', 'epodsystem']);
    expect(channels.map((c) => c.instructions)).toEqual(['deploy the app', 'publish the theme']);
  });

  // cm:guard `integration_bindings.label` is the ISS-558 multi-store slug and sits inside a unique index; reading the pool out of it would make "which box releases" and "which store is this" the same field, and a second store would silently repoint the release
  it('never reads the pool out of the multi-store label column', async () => {
    listBindings.mockResolvedValue([binding({ label: 'aurelle' })]);

    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.releaseRunnerLabel).toBeNull();
  });

  it('takes the pool label from config, with the binding overriding the connection', async () => {
    listBindings.mockResolvedValue([
      binding({
        connectionConfig: { releaseRunnerLabel: 'org-wide' },
        bindingConfig: { releaseRunnerLabel: 'epod-prod' },
      }),
    ]);

    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.releaseRunnerLabel).toBe('epod-prod');
  });

  it('treats an empty label as no pool rather than as a pool nothing is in', async () => {
    listBindings.mockResolvedValue([binding({ bindingConfig: { releaseRunnerLabel: '' } })]);

    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.releaseRunnerLabel).toBeNull();
  });
});

describe('releaseRunnerLabelOf', () => {
  // cm:guard the ONE axis on which the set still collapses to a single answer, because it names a
  // MACHINE. Returning the set here and letting a caller take `[0]` would put back the silent pick
  // `resolveReleaseChannels` exists to remove, one layer up.
  it('refuses by name when two live bindings declare different labels', () => {
    const channels = [
      { releaseRunnerLabel: 'release' },
      { releaseRunnerLabel: 'epod-prod' },
    ] as Parameters<typeof releaseRunnerLabelOf>[1];
    expect(() => releaseRunnerLabelOf(PROJECT_ID, channels)).toThrow(ReleaseRunnerAmbiguousError);
    expect(() => releaseRunnerLabelOf(PROJECT_ID, channels)).toThrow(/RELEASE_RUNNER_AMBIGUOUS/);
  });

  it('names both labels in the message, so an operator can see which two disagree', () => {
    const channels = [
      { releaseRunnerLabel: 'release' },
      { releaseRunnerLabel: 'epod-prod' },
    ] as Parameters<typeof releaseRunnerLabelOf>[1];
    expect(() => releaseRunnerLabelOf(PROJECT_ID, channels)).toThrow(/release[\s\S]*epod-prod/);
  });

  // cm:guard an UNLABELLED binding beside a labelled one is not a disagreement: home-kieutrung
  // carries a coolify binding and an epodsystem one at live, and only one of them has any reason to
  // name the box. Refusing this pair would make a two-endpoint project undeclarable.
  it('accepts one label beside any number of unlabelled bindings', () => {
    const channels = [
      { releaseRunnerLabel: null },
      { releaseRunnerLabel: 'release' },
      { releaseRunnerLabel: null },
    ] as Parameters<typeof releaseRunnerLabelOf>[1];
    expect(releaseRunnerLabelOf(PROJECT_ID, channels)).toBe('release');
  });

  it('answers null where nothing declares a label', () => {
    expect(releaseRunnerLabelOf(PROJECT_ID, [])).toBeNull();
  });

  it('accepts the same label declared twice', () => {
    const channels = [
      { releaseRunnerLabel: 'release' },
      { releaseRunnerLabel: 'release' },
    ] as Parameters<typeof releaseRunnerLabelOf>[1];
    expect(releaseRunnerLabelOf(PROJECT_ID, channels)).toBe('release');
  });
});

describe('resolveReleasePlan', () => {
  it('reads the project-authored procedure', async () => {
    knowledgeEntry.mockResolvedValue({ body: 'run ./release.sh, no squash', archivedAt: null });

    expect((await resolveReleasePlan(PROJECT_ID)).procedure).toBe('run ./release.sh, no squash');
  });

  it('asks for the release-procedure slug and no other', async () => {
    knowledgeEntry.mockResolvedValue({ body: 'x', archivedAt: null });
    await resolveReleasePlan(PROJECT_ID);
    expect(knowledgeEntry).toHaveBeenCalledWith(PROJECT_ID, 'release-procedure');
  });

  it('treats a blank body as absent, so the caller falls back instead of printing nothing', async () => {
    knowledgeEntry.mockResolvedValue({ body: '  ', archivedAt: null });

    expect((await resolveReleasePlan(PROJECT_ID)).procedure).toBeNull();
  });

  it('falls back when the project has written no procedure at all', async () => {
    knowledgeEntry.mockResolvedValue(null);

    expect((await resolveReleasePlan(PROJECT_ID)).procedure).toBeNull();
  });

  // cm:guard an archived entry is one its owner took down. Reading its body back would hand the
  // release agent a procedure the settings screen says is gone — the same fence `master-policy`
  // needs, and the reason both reads check `archivedAt` rather than trusting the row's existence.
  it('ignores an archived procedure rather than following text its owner retired', async () => {
    knowledgeEntry.mockResolvedValue({ body: 'the old way', archivedAt: new Date() });

    expect((await resolveReleasePlan(PROJECT_ID)).procedure).toBeNull();
  });
});

describe('resolveReleaseDeviceIds', () => {
  it('returns the devices whose runners carry the label', async () => {
    dbExecute.mockResolvedValue([{ device_id: 'dev-a' }, { device_id: 'dev-b' }]);

    expect(await resolveReleaseDeviceIds(PROJECT_ID, 'epod-prod')).toEqual(['dev-a', 'dev-b']);
  });

  // cm:guard an empty pool must reach the caller as an empty list, never as null: the service reads null as "no pool declared" and falls back to the whole fleet, which is the one thing a declared pool exists to prevent
  it('returns an empty list when no runner carries the label', async () => {
    expect(await resolveReleaseDeviceIds(PROJECT_ID, 'nobody-has-this')).toEqual([]);
  });
});

describe('classifyRollback', () => {
  it('reads prose on a coolify binding as unrepresentable, never as a procedure to follow', () => {
    expect(classifyRollback('coolify', 'ssh in and redeploy the previous tag')).toEqual({
      kind: 'unrepresentable',
      text: 'ssh in and redeploy the previous tag',
    });
  });

  it('keeps prose on a channel whose API cannot roll anything back', () => {
    expect(classifyRollback('epodsystem', 'promote the previous theme revision')).toEqual({
      kind: 'manual',
      text: 'promote the previous theme revision',
    });
  });

  it('reads the declared coolify action', () => {
    expect(classifyRollback('coolify', { mode: 'coolify-image' })).toEqual({
      kind: 'coolify-image',
    });
  });

  it('reads whitespace and anything unrecognised as no declaration at all', () => {
    expect(classifyRollback('coolify', '   ')).toBeNull();
    expect(classifyRollback('coolify', { mode: 'something-else' })).toBeNull();
    expect(classifyRollback('coolify', undefined)).toBeNull();
  });

  it('is what resolveReleaseChannels returns for each live binding', async () => {
    listBindings.mockResolvedValue([
      binding({ provider: 'coolify', bindingConfig: { rollback: 'redeploy by hand' } }),
    ]);
    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.rollback).toEqual({
      kind: 'unrepresentable',
      text: 'redeploy by hand',
    });
  });
});
