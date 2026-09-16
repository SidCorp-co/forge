// Two questions the batch used to answer for everybody the same way: what does
// this project's release actually consist of, and which box is allowed to run
// it. Both are per project, and both used to be hardcoded.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    selectLimit.mockResolvedValue([
      { agentConfig: { projectFacts: { 'release-procedure': 'run ./release.sh, no squash' } } },
    ]);

    expect((await resolveReleasePlan(PROJECT_ID)).procedure).toBe('run ./release.sh, no squash');
  });

  it('treats a blank fact as absent, so the caller falls back instead of printing nothing', async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { projectFacts: { 'release-procedure': '  ' } } },
    ]);

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
