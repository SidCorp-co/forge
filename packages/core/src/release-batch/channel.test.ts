import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  projectRunnerDeviceIds,
  resolveReleaseDeviceIds,
  resolveReleasePlan,
} = await import('./channel.js');

// `channel.ts` asks the registry what a provider DECLARES (its release step, its rollback representability,
// its webhook header) rather than naming providers (ISS-1071). Reading an empty registry throws
// rather than answering "no provider declares anything", which is the answer that would have made
// these assertions pass while describing a deployment with no integrations in it.
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

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

  it('returns every live deploy binding with its own instructions, in order', async () => {
    listBindings.mockResolvedValue([
      binding({ provider: 'coolify', instructions: 'deploy the app' }),
      binding({ provider: 'epodsystem', instructions: 'publish the theme' }),
    ]);

    const channels = await resolveReleaseChannels(PROJECT_ID);

    expect(channels.map((c) => c.provider)).toEqual(['coolify', 'epodsystem']);
    expect(channels.map((c) => c.instructions)).toEqual(['deploy the app', 'publish the theme']);
  });

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

/**
 * ISS-1069 — a project's own live address becomes the probe a binding that declares none gets.
 *
 * Before this, declaring `verify.probes` needed the one thing Forge did not hold: the project's
 * production hostname. 0 of 32 projects filled it and `sidpeak` could not cut a release at all.
 * The rule that matters here is WHEN the default fires — on absence, never on a declaration
 * `parseVerifyConfig` refused — because filling in for a broken declaration would verify somewhere
 * the operator never named and wear a green verdict doing it.
 */
describe('resolveReleaseChannels — the probe a live address earns', () => {
  const LIVE = {
    live: { url: 'https://app.x', commitUrl: 'https://api.x/health', commitPath: 'data.commit' },
  };

  it.each([
    ['no verify key at all', {}],
    ['a JSON-null verify', { verify: null }],
  ])('defaults the probe from environments.live for a binding with %s', async (_l, cfg) => {
    listBindings.mockResolvedValue([binding({ bindingConfig: cfg })]);
    selectLimit.mockResolvedValue([{ environments: LIVE }]);

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel?.verify?.probes).toEqual([
      { url: 'https://api.x/health', commitPath: 'data.commit' },
    ]);
    expect(channel?.verifySource).toBe('environments-live');
  });

  it.each([
    ['an empty verify object', { verify: {} }],
    ['a verify with an empty probe list', { verify: { probes: [] } }],
    ['probes with no url', { verify: { probes: [{ commitPath: 'commit' }] } }],
  ])('takes NO default for a binding declaring %s', async (_l, cfg) => {
    listBindings.mockResolvedValue([binding({ bindingConfig: cfg })]);
    selectLimit.mockResolvedValue([{ environments: LIVE }]);

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel?.verify).toBeNull();
    expect(channel?.verifySource).toBe('none');
  });

  it('keeps a usable binding declaration whatever environments.live holds', async () => {
    listBindings.mockResolvedValue([
      binding({
        bindingConfig: { verify: { probes: [{ url: 'https://own.x/health', commitPath: 'c' }] } },
      }),
    ]);
    selectLimit.mockResolvedValue([{ environments: LIVE }]);

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel?.verify?.probes).toEqual([{ url: 'https://own.x/health', commitPath: 'c' }]);
    expect(channel?.verifySource).toBe('binding');
  });

  it('reports `none` where the binding declares nothing and the project holds no live commit endpoint', async () => {
    listBindings.mockResolvedValue([binding({})]);
    selectLimit.mockResolvedValue([{ environments: { live: { url: 'https://app.x' } } }]);

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel?.verify).toBeNull();
    expect(channel?.verifySource).toBe('none');
  });

  it('omits commitPath entirely where the project declares none', async () => {
    listBindings.mockResolvedValue([binding({})]);
    selectLimit.mockResolvedValue([
      { environments: { live: { commitUrl: 'https://api.x/health', commitPath: null } } },
    ]);

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel?.verify?.probes[0]).toEqual({ url: 'https://api.x/health' });
  });

  it('reads the project row once for any number of bindings', async () => {
    listBindings.mockResolvedValue([
      binding({ provider: 'coolify' }),
      binding({ provider: 'epodsystem' }),
    ]);
    selectLimit.mockResolvedValue([{ environments: LIVE }]);

    const channels = await resolveReleaseChannels(PROJECT_ID);
    expect(channels.map((c) => c.verifySource)).toEqual(['environments-live', 'environments-live']);
    expect(selectLimit).toHaveBeenCalledTimes(1);
  });

  it('reads no project row at all where the project declares no live binding', async () => {
    listBindings.mockResolvedValue([]);
    expect(await resolveReleaseChannels(PROJECT_ID)).toEqual([]);
    expect(selectLimit).not.toHaveBeenCalled();
  });
});

describe('releaseRunnerLabelOf', () => {
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

  it('returns an empty list when no runner carries the label', async () => {
    expect(await resolveReleaseDeviceIds(PROJECT_ID, 'nobody-has-this')).toEqual([]);
  });
});

describe('projectRunnerDeviceIds', () => {
  it('returns every device the project has a runner row for', async () => {
    dbExecute.mockResolvedValue([{ device_id: 'dev-a' }, { device_id: 'dev-b' }]);

    expect(await projectRunnerDeviceIds(PROJECT_ID)).toEqual(['dev-a', 'dev-b']);
  });

  // The one case RELEASE_POOL_EMPTY now means, and the only one: a project with
  // no box at all, rather than a fleet a preference emptied.
  it('returns an empty list where the project has no runner at all', async () => {
    expect(await projectRunnerDeviceIds(PROJECT_ID)).toEqual([]);
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
