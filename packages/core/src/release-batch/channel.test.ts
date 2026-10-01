import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOC_PROJECT,
  PROD_BINDING,
  production,
  projectDoc,
  sourceProbe,
} from '../project-config/release-path.fixture.js';
import type { EnvironmentDeclaration, ProjectDocument } from '../project-config/schema.js';

// Since ISS-1048 the release procedure is a knowledge entry rather than an `agentConfig` key, so
// the fixture is a row from that store and the mock sits at the service seam.
type Entry = { body: string; archivedAt: Date | null } | null;
const knowledgeEntry = vi.fn(async (_id: string, _slug: string): Promise<Entry> => null);
vi.mock('../knowledge/service.js', () => ({
  getKnowledgeEntry: (id: string, slug: string) => knowledgeEntry(id, slug),
}));

const dbExecute = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const selectLimit = vi.fn(async () => [{ id: DOC_PROJECT }] as unknown[]);
const readDocument = vi.fn(
  async (): Promise<{ revision: number; document: ProjectDocument } | null> => null,
);
const findBinding = vi.fn(async (_id: string) => null as unknown);

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...a: unknown[]) => dbExecute(...a),
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));

vi.mock('../project-config/service.js', () => ({
  readProjectDocument: () => readDocument(),
}));

vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, findBindingWithConnectionById: (id: string) => findBinding(id) };
});

const {
  classifyRollback,
  closeVerification,
  releaseRunnerLabelOf,
  resolveReleaseChannels,
  projectRunnerDeviceIds,
  resolveReleaseDeviceIds,
  resolveReleasePlan,
} = await import('./channel.js');
const { ReleaseProbesUnreadableError } = await import('./errors.js');

// The code under test asks the registry what a provider DECLARES (its rollback representability,
// its webhook header) rather than naming providers (ISS-1071). An empty registry throws rather
// than answering "no provider declares anything", which would pass these assertions while
// describing a deployment with no integrations in it.
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = DOC_PROJECT;

function binding(over: {
  provider?: string;
  instructions?: string | null;
  bindingConfig?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  label?: string;
}) {
  return {
    binding: {
      id: PROD_BINDING,
      projectId: DOC_PROJECT,
      active: true,
      provider: over.provider ?? 'coolify',
      instructions: over.instructions ?? null,
      config: over.bindingConfig ?? {},
      label: over.label ?? '',
      role: 'deploy' as const,
    },
    connection: { active: true, config: over.connectionConfig ?? {} },
  };
}

const gatedOn = (env: EnvironmentDeclaration = production()) =>
  readDocument.mockResolvedValue({
    revision: 2,
    document: projectDoc({ environments: { beta: env } }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ id: DOC_PROJECT }]);
  readDocument.mockResolvedValue(null);
  findBinding.mockResolvedValue(binding({}));
  dbExecute.mockResolvedValue([]);
});

describe('resolveReleaseChannels', () => {
  it('reports an empty set where the project document declares no production environment', async () => {
    readDocument.mockResolvedValue({ revision: 1, document: projectDoc({}) });
    expect(await resolveReleaseChannels(PROJECT_ID)).toEqual([]);
  });

  it("is the production environment's binding, with the operator text carried verbatim", async () => {
    gatedOn();
    findBinding.mockResolvedValue(binding({ instructions: 'ship the frontend WITH varnish' }));

    const channels = await resolveReleaseChannels(PROJECT_ID);

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      environment: 'beta',
      bindingId: PROD_BINDING,
      provider: 'coolify',
      instructions: 'ship the frontend WITH varnish',
    });
  });

  it('never reads the pool out of the multi-store label column', async () => {
    gatedOn();
    findBinding.mockResolvedValue(binding({ label: 'aurelle' }));

    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.releaseRunnerLabel).toBeNull();
  });

  it('takes the pool label from config, with the binding overriding the connection', async () => {
    gatedOn();
    findBinding.mockResolvedValue(
      binding({
        connectionConfig: { releaseRunnerLabel: 'org-wide' },
        bindingConfig: { releaseRunnerLabel: 'epod-prod' },
      }),
    );

    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.releaseRunnerLabel).toBe('epod-prod');
  });

  it('treats an empty label as no pool rather than as a pool nothing is in', async () => {
    gatedOn();
    findBinding.mockResolvedValue(binding({ bindingConfig: { releaseRunnerLabel: '' } }));

    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.releaseRunnerLabel).toBeNull();
  });
});

/**
 * ISS-12 — a release is proved by the production environment's runtime probes, and only those
 * that identify the SOURCE: a release ships a commit, and an artifact digest cannot be compared
 * with one. A binding's own `verify` is no longer read.
 */
describe('resolveReleaseChannels — the probes production declares', () => {
  it('proves a release with each source probe of the production environment', async () => {
    gatedOn(
      production({
        verification: {
          runtime: [
            sourceProbe('https://api.x/version', 'data.commit'),
            { type: 'http', url: 'https://cdn.x/build', path: 'digest', identifies: 'artifact' },
          ],
        },
      }),
    );

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel?.verify?.probes).toEqual([
      { url: 'https://api.x/version', commitPath: 'data.commit' },
    ]);
    expect(channel?.verifySource).toBe('environment');
  });

  it('calls a production declaring only artifact probes declared-unusable, with no fallback', async () => {
    gatedOn(
      production({
        verification: {
          runtime: [
            { type: 'http', url: 'https://cdn.x/build', path: 'digest', identifies: 'artifact' },
          ],
        },
      }),
    );

    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel).toMatchObject({ verify: null, verifySource: 'declared-unusable' });
    expect(() => closeVerification([channel as NonNullable<typeof channel>])).toThrow(
      ReleaseProbesUnreadableError,
    );
  });

  it('reports `none` where production declares no runtime probe', async () => {
    gatedOn();
    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel).toMatchObject({ verify: null, verifySource: 'none' });
  });

  it('never reads a verify the binding still carries from before ISS-12', async () => {
    gatedOn();
    findBinding.mockResolvedValue(
      binding({ bindingConfig: { verify: { probes: [{ url: 'https://own.x/health' }] } } }),
    );
    const [channel] = await resolveReleaseChannels(PROJECT_ID);
    expect(channel).toMatchObject({ verify: null, verifySource: 'none' });
  });
});

describe('closeVerification (ISS-1321)', () => {
  type Channels = Parameters<typeof closeVerification>[0];
  const readable = { probes: [{ url: 'https://api.example.test/version' }] };
  const probed = {
    environment: 'beta',
    bindingId: 'b-a',
    provider: 'coolify',
    label: '',
    verify: readable,
    verifySource: 'environment',
  };
  const none = {
    environment: 'beta',
    bindingId: 'b-b',
    provider: 'coolify',
    label: 'eu',
    verify: null,
    verifySource: 'none',
  };
  const refused = {
    environment: 'beta',
    bindingId: 'b-c',
    provider: 'coolify',
    label: '',
    verify: null,
    verifySource: 'declared-unusable',
  };

  it('answers probed with the channel probes where production declares them', () => {
    expect(closeVerification([probed] as unknown as Channels)).toEqual({
      kind: 'probed',
      cfg: readable,
    });
  });

  it('answers unverified where production declares no probe, and where there is no channel', () => {
    expect(closeVerification([none] as unknown as Channels)).toEqual({ kind: 'unverified' });
    expect(closeVerification([])).toEqual({ kind: 'unverified' });
  });

  it('is proved by the readable probes whichever binding sorts first', () => {
    const first = closeVerification([none, probed] as unknown as Channels);
    const last = closeVerification([probed, none] as unknown as Channels);
    expect(first).toEqual({ kind: 'probed', cfg: readable });
    expect(last).toEqual(first);
  });

  it('throws RELEASE_PROBES_UNREADABLE naming a binding whose verify was refused', () => {
    const run = () => closeVerification([probed, refused] as unknown as Channels);
    expect(run).toThrow(ReleaseProbesUnreadableError);
    expect(run).toThrow(/RELEASE_PROBES_UNREADABLE: .*environment `beta` \(coolify b-c\)/);
  });

  it('names the store slug where the binding carries one', () => {
    const run = () => closeVerification([{ ...refused, label: 'eu' }] as unknown as Channels);
    expect(run).toThrow(/coolify \[eu\] b-c/);
  });
});

describe('releaseRunnerLabelOf', () => {
  it("answers the production channel's label", () => {
    const channels = [{ releaseRunnerLabel: 'release' }] as unknown as Parameters<
      typeof releaseRunnerLabelOf
    >[0];
    expect(releaseRunnerLabelOf(channels)).toBe('release');
  });

  it('answers null where nothing declares a label', () => {
    expect(releaseRunnerLabelOf([])).toBeNull();
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

  it('is what resolveReleaseChannels returns for the production binding', async () => {
    gatedOn();
    findBinding.mockResolvedValue(
      binding({ provider: 'coolify', connectionConfig: { rollback: 'redeploy by hand' } }),
    );
    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.rollback).toEqual({
      kind: 'unrepresentable',
      text: 'redeploy by hand',
    });
  });

  it('reads no rollback off the binding, which binding-v1 removed', async () => {
    gatedOn();
    findBinding.mockResolvedValue(
      binding({ provider: 'coolify', bindingConfig: { rollback: { mode: 'coolify-image' } } }),
    );
    expect((await resolveReleaseChannels(PROJECT_ID))[0]?.rollback).toBeNull();
  });
});
