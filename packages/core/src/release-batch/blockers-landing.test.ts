/**
 * ISS-1327 — the record door's `RELEASE_WORK_UNMERGED` on a project whose work lands outside git.
 *
 * The roster filter is `landing-evidence.ts`'s answer, so a website issue whose mark names no landing
 * is unmerged though `merged_at` is set, and its sentence speaks of a landing, never of a branch.
 * Beside `blockers.test.ts`, with its mocks, because that file is at its size budget; the door is
 * also held against Postgres in `tests/integration/landing-evidence-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const fromChain: Record<string, unknown> = {};
fromChain.where = () => Object.assign(selectRows(), { limit: selectLimit });
fromChain.innerJoin = fromChain.leftJoin = () => fromChain;
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => fromChain }), execute: async () => [] },
}));

vi.mock('../integrations/store.js', async (importActual) => ({
  ...(await importActual<typeof import('../integrations/store.js')>()),
  listActiveDeployBindingsForStage: async () => [
    {
      binding: { id: 'b-1', provider: 'coolify', config: {}, instructions: null, label: '' },
      connection: { config: {} },
    },
  ],
}));
vi.mock('../runners/select.js', () => ({ onlineCapableDeviceIds: async () => [] }));
vi.mock('./queries.js', async (importActual) => ({
  ...(await importActual<typeof import('./queries.js')>()),
  getActiveReleaseBatch: async () => null,
}));
vi.mock('../issues/release-record-required.js', async (importActual) => ({
  ...(await importActual<typeof import('../issues/release-record-required.js')>()),
  issuesMissingReleaseRecord: async () => [],
}));

const { collectReleaseBlockers } = await import('./blockers.js');
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const ISSUE = '66666666-6666-4666-8666-666666666666';

beforeEach(() => {
  selectLimit.mockResolvedValue([
    { repoPath: null, repoUrl: null, baseBranch: 'main', releaseChain: [{ branch: 'main' }] },
  ]);
});

async function unmergedAtTheRecordDoor(mark: Record<string, unknown>) {
  selectRows.mockResolvedValue([
    { id: ISSUE, status: 'awaiting_release', claimed: null, mergedCommitSha: null, ...mark },
  ]);
  const { blockers } = await collectReleaseBlockers(PROJECT_ID, {
    issueIds: [ISSUE],
    door: 'record',
  });
  return blockers.find((b) => b.code === 'RELEASE_WORK_UNMERGED');
}

describe('RELEASE_WORK_UNMERGED on a project whose work lands outside git', () => {
  it('lists an issue whose mark names no landing, though merged_at is set', async () => {
    const unmerged = await unmergedAtTheRecordDoor({
      mergedAt: new Date('2026-09-26T12:20:00Z'),
      mergedLanding: null,
      kind: 'website',
    });
    expect(unmerged?.details).toEqual({ issueIds: [ISSUE], shape: 'outside_git' });
    expect(unmerged?.message).toContain('`landing`');
    expect(unmerged?.message).not.toMatch(/branch/);
  });

  it('lists nothing for an issue whose mark names where it landed', async () => {
    const unmerged = await unmergedAtTheRecordDoor({
      mergedAt: new Date('2026-09-26T12:20:00Z'),
      mergedLanding: 'https://mowmentbrand.com/products/linen-tee',
      kind: 'website',
    });
    expect(unmerged).toBeUndefined();
  });

  it('keeps the git sentence, which names the branch, on a project that lands in git', async () => {
    const unmerged = await unmergedAtTheRecordDoor({
      mergedAt: null,
      mergedLanding: null,
      kind: 'standard',
    });
    expect(unmerged?.details).toEqual({ issueIds: [ISSUE], shape: 'git' });
    expect(unmerged?.message).toContain('the branch this release deployed');
  });
});
