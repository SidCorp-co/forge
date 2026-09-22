/**
 * One property of the enumerator, on its own because it is not about what the
 * report SAYS: collecting the reasons a release will not start opens no
 * connection. Criterion 16 of ISS-1127 was true when it was judged and no test
 * held it, so a transport added to any check would have landed green — and
 * `evaluate` would have swallowed its failure into an unevaluated blocker,
 * which leaves the call count as the only thing that can see it.
 *
 * Guarded at the socket rather than at `fetch`: every client in this runtime,
 * `fetch` included, reaches `Socket.prototype.connect` to open one.
 */

import { Socket } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const execRows = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Object.assign(selectRows(), { limit: selectLimit }) }),
    }),
    execute: () => execRows(),
  },
}));

const listBindings = vi.fn(async () => [] as unknown[]);
vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const onlineIds = vi.fn(async () => [] as string[]);
vi.mock('../runners/select.js', () => ({
  onlineCapableDeviceIds: (...a: unknown[]) => onlineIds(...(a as [])),
}));

const activeBatch = vi.fn(async () => null as { runId: string } | null);
vi.mock('./queries.js', async (importActual) => {
  const actual = await importActual<typeof import('./queries.js')>();
  return { ...actual, getActiveReleaseBatch: () => activeBatch() };
});

const missingNotes = vi.fn(async () => [] as string[]);
vi.mock('../issues/release-record-required.js', async (importActual) => {
  const actual = await importActual<typeof import('../issues/release-record-required.js')>();
  return { ...actual, issuesMissingReleaseRecord: () => missingNotes() };
});

const { collectReleaseBlockers } = await import('./blockers.js');
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const ISSUE_A = '66666666-6666-4666-8666-666666666666';

const PROBES = { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] };
const DECLARED = {
  releaseRunnerLabel: 'prod-box',
  verify: PROBES,
  rollback: { mode: 'coolify-image' },
};

function liveBinding(config: Record<string, unknown>) {
  listBindings.mockResolvedValue([
    {
      binding: {
        id: 'b-1',
        provider: 'coolify',
        config,
        instructions: null,
        label: '',
        role: 'deploy',
        stages: ['live'],
      },
      connection: { config: {} },
    },
  ]);
}

function roster(mergedAt: Date | null) {
  selectRows.mockResolvedValue([
    { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt },
  ]);
}

/** A project with nothing wrong with it, and one merged issue waiting. */
function ready() {
  selectLimit.mockResolvedValue([
    {
      repoPath: '/srv/app',
      repoUrl: null,
      baseBranch: 'main',
      liveBranch: null,
      releaseModel: 'publish',
      releaseStrategy: null,
      environments: {
        live: { url: 'https://app.example.test', commitUrl: 'https://example.test/api/health' },
      },
    },
  ]);
  liveBinding(DECLARED);
  roster(new Date());
  execRows.mockResolvedValue([{ device_id: 'dev-1' }]);
  onlineIds.mockResolvedValue(['dev-1']);
}

/** Each state is a different set of checks reaching a different read. */
const STATES: Record<string, () => void> = {
  'a project that can release': ready,
  'a probe url no request could be made to': () => {
    ready();
    liveBinding({ ...DECLARED, verify: { probes: [{ url: 'example.test/version' }] } });
  },
  'a roster whose work never merged': () => {
    ready();
    roster(null);
  },
  'a binding store the declaration cannot read': () => {
    ready();
    listBindings.mockRejectedValue(new Error('binding store unreachable'));
  },
  'a project row the declaration cannot read': () => {
    ready();
    selectLimit.mockRejectedValue(new Error('projects table unreadable'));
  },
  'a pool read that throws': () => {
    ready();
    onlineIds.mockRejectedValue(new Error('pool table unreadable'));
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
  selectRows.mockResolvedValue([]);
  execRows.mockResolvedValue([]);
  onlineIds.mockResolvedValue([]);
  activeBatch.mockResolvedValue(null);
  missingNotes.mockResolvedValue([]);
});

describe('collectReleaseBlockers — no unreachable probe can withhold the answer', () => {
  for (const [state, plant] of Object.entries(STATES)) {
    it(`opens no connection at either door for ${state}`, async () => {
      const dialled = vi.fn(() => {
        throw new Error('collectReleaseBlockers reached the network');
      });
      const realFetch = globalThis.fetch;
      const realConnect = Socket.prototype.connect;
      globalThis.fetch = dialled as unknown as typeof fetch;
      Socket.prototype.connect = dialled as never;
      try {
        plant();
        await collectReleaseBlockers(PROJECT_ID);
        await collectReleaseBlockers(PROJECT_ID, { door: 'record', issueIds: [ISSUE_A] });
      } finally {
        globalThis.fetch = realFetch;
        Socket.prototype.connect = realConnect;
      }

      expect(dialled).not.toHaveBeenCalled();
    });
  }
});
