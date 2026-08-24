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
  return { ...actual, listActiveBindingsForEnvironment: () => listBindings() };
});

const { resolveReleaseChannel, resolveReleaseDeviceIds, resolveReleasePlan } = await import(
  './channel.js'
);

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
      provider: over.provider ?? 'coolify',
      instructions: over.instructions ?? null,
      config: over.bindingConfig ?? {},
      label: over.label ?? '',
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

describe('resolveReleaseChannel', () => {
  it('reports no channel when the project declares no production binding', async () => {
    expect(await resolveReleaseChannel(PROJECT_ID)).toEqual({
      provider: null,
      instructions: null,
      releaseRunnerLabel: null,
    });
  });

  it('carries the operator text through verbatim', async () => {
    listBindings.mockResolvedValue([
      binding({ provider: 'coolify', instructions: 'ship the frontend WITH varnish' }),
    ]);

    const channel = await resolveReleaseChannel(PROJECT_ID);

    expect(channel.provider).toBe('coolify');
    expect(channel.instructions).toBe('ship the frontend WITH varnish');
  });

  // cm:guard `integration_bindings.label` is the ISS-558 multi-store slug and sits inside a unique index; reading the pool out of it would make "which box releases" and "which store is this" the same field, and a second store would silently repoint the release
  it('never reads the pool out of the multi-store label column', async () => {
    listBindings.mockResolvedValue([binding({ label: 'aurelle' })]);

    expect((await resolveReleaseChannel(PROJECT_ID)).releaseRunnerLabel).toBeNull();
  });

  it('takes the pool label from config, with the binding overriding the connection', async () => {
    listBindings.mockResolvedValue([
      binding({
        connectionConfig: { releaseRunnerLabel: 'org-wide' },
        bindingConfig: { releaseRunnerLabel: 'epod-prod' },
      }),
    ]);

    expect((await resolveReleaseChannel(PROJECT_ID)).releaseRunnerLabel).toBe('epod-prod');
  });

  it('treats an empty label as no pool rather than as a pool nothing is in', async () => {
    listBindings.mockResolvedValue([binding({ bindingConfig: { releaseRunnerLabel: '' } })]);

    expect((await resolveReleaseChannel(PROJECT_ID)).releaseRunnerLabel).toBeNull();
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

  // cm:guard an empty pool must reach the caller as an empty list, never as null: the service reads null as "no pool declared" and falls back to the whole fleet, which is the one thing a declared pool exists to prevent
  it('returns an empty list when no runner carries the label', async () => {
    expect(await resolveReleaseDeviceIds(PROJECT_ID, 'nobody-has-this')).toEqual([]);
  });
});
