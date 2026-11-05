/**
 * ISS-968, as agenfold met it on 2026-11-04 (FB-495): ISS-160 was held at the release gate for an
 * unearned criterion while its landing was already on main, under ISS-161's; ISS-161 was earned. The
 * sweep cut ISS-161 alone twice (0.129.0, 0.130.0), and both runs aborted at their range report
 * (RELEASE_RANGE_OUTSIDE_ROSTER), because the head production builds carried ISS-160.
 *
 * Planted against real Postgres: two waiting issues on an on-land project, the earlier held by a
 * skipped criterion and landed under the head, the later earned; the sweep ticks twice. No cut is
 * taken, the wait is said once on the earned issue's hold naming the held one, its hold and what ends
 * it, and once the held criterion is earned the next tick cuts both. A held landing the head does not
 * carry holds nothing, and a head nobody could read is named and does not stop the cut. The
 * repository's history and its head are planted as the ancestry reader and the head door answer them.
 *
 * @direct-test-of packages/core/src/release-batch/sweep-head.ts
 * @direct-test-of packages/core/src/release-batch/release-sweep.ts
 * @direct-test-of packages/core/src/release-batch/range-outside.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { type ProductionHead, productionHead } from '../../src/release-batch/sweep-head.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import {
  AT_RELEASE,
  declareProductionDocument,
  fakeCoolify,
  releaseWorld,
  verdictComment,
} from '../helpers/release-world.js';

// main as agenfold's held it: ISS-160's re-landing (636cffe), then ISS-161's above it; and a commit on
// a branch off ISS-160's base that main never took
const H = vi.hoisted(() => {
  const held = '636cffe000000000000000000000000000000160';
  const earned = '161ea4e000000000000000000000000000000161';
  const aside = 'a51de00000000000000000000000000000000b2c';
  const holds: Record<string, readonly string[]> = {
    [held]: [held],
    [earned]: [held, earned],
    [aside]: [aside],
  };
  return { held, earned, aside, holds };
});

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
  ancestrySourceFor: async () => ({
    kind: 'box',
    why: 'the planted box',
    reader: {
      async ask(pairs: readonly { commit: string; release: string }[]) {
        const out = new Map<string, boolean | { unread: string }>();
        for (const p of pairs) {
          const held = H.holds[p.release];
          out.set(
            `${p.commit}@${p.release}`,
            held ? held.includes(p.commit) : { unread: 'no history' },
          );
        }
        return out;
      },
      witness: () => ({ via: 'source-host' }),
    },
  }),
}));

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
const CODE = 'RELEASE_HEAD_CARRIES_HELD';

function verdictBlock(criterion: number, verdict: string): string {
  return [
    `criterion: ${criterion}`,
    `verdict: ${verdict}`,
    `runtime: ${SERVING}`,
    'evidence: judge-evidence.txt',
    'why: exercised directly',
    'judge: judge-1',
    'judge-from: inherited',
  ].join('\n');
}

let projectId: string;
let ownerId: string;
let head: ProductionHead;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));

/** A waiting row with two criteria carrying `blocks`, landed at `commit`, `minutesAgo` minutes ago. */
async function waitingRow(commit: string, minutesAgo: number, blocks: string[]): Promise<string> {
  const id = await fx.insertIssue('awaiting_release', undefined, true, ['one', 'two']);
  const landing = JSON.stringify({ landing: { head: commit, deployment: SERVING } });
  await db.execute(sql`
    UPDATE issues SET session_context = ${landing}::jsonb, merged_commit_sha = ${commit},
                      merged_at = now() - make_interval(mins => ${minutesAgo})
     WHERE id = ${id}
  `);
  await fx.postVerdict(id, verdictComment(blocks));
  return id;
}

/** ISS-160 held on its skipped criterion 2 at `heldAt`, and ISS-161 earned at the head. */
async function agenfold(heldAt = H.held) {
  const held = await waitingRow(heldAt, 30, [verdictBlock(1, 'pass'), verdictBlock(2, 'skipped')]);
  const earned = await waitingRow(H.earned, 10, [verdictBlock(1, 'pass'), verdictBlock(2, 'pass')]);
  const [heldKey] = await fx.displayIds([held]);
  return { held, earned, heldKey: String(heldKey) };
}

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await declareControls(projectId, ownerId, { delivery: { verdictsRequired: true } });
  const bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  await declareProductionDocument({ projectId, ownerId, bindingId, trigger: 'on-land' });
  coolify.applications.clear();
  coolify.deployed(APP.resourceUuid, 'dep-1', SERVING, '2026-11-04T23:00:00Z');
  fx.serve(SERVING);
  await fx.seedReleaseRunner();
  head = { branch: 'main', sha: H.earned };
  vi.spyOn(productionHead, 'read').mockImplementation(async () => head);
});

describe('the sweep reads what the head production builds carries before it cuts (ISS-968)', () => {
  it('waits on the held issue under the head, says so once, and cuts both once its hold clears', async () => {
    const w = await agenfold();

    const first = await sweepAutomaticReleases();
    const second = await sweepAutomaticReleases();

    // no cut known to abort: the earned issue stays unclaimed, on both ticks
    expect(first).toMatchObject({ issuesCut: 0, projectsCut: 0, issuesWaiting: 1 });
    expect(second).toMatchObject({ issuesCut: 0, projectsCut: 0, holdsWritten: 0 });
    expect((await fx.stored(w.earned)).claim).toBeNull();
    expect((await fx.stored(w.held)).claim).toBeNull();
    // the held issue keeps its own hold; the earned one waits on it, by name, said once
    expect((await fx.holdOf(w.held))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    const wait = await fx.holdOf(w.earned);
    expect(wait?.code).toBe(CODE);
    expect(wait?.reason).toContain('161ea4e of `main`');
    expect(wait?.reason).toContain(
      `${w.heldKey} (landed at 636cffe), held RELEASE_CRITERIA_UNEARNED`,
    );
    expect(wait?.reason).toContain('RELEASE_RANGE_OUTSIDE_ROSTER');
    expect(wait?.reason).toContain(`/api/projects/${projectId}/release-batches`);
    expect(wait?.waitingFor).toBe(
      `${w.heldKey} to clear its hold, or a release cut by hand naming it`,
    );
    expect(await fx.holdHistory(w.earned)).toHaveLength(1);

    // the held criterion earned: the next tick cuts both together
    await fx.postVerdict(w.held, verdictComment([verdictBlock(2, 'pass')]));
    const third = await sweepAutomaticReleases();

    expect(third).toMatchObject({ issuesCut: 2, projectsCut: 1, issuesWaiting: 0 });
    const [held, earned] = [await fx.stored(w.held), await fx.stored(w.earned)];
    expect(earned).toMatchObject(AT_RELEASE);
    expect(earned.claim).not.toBeNull();
    expect(held.claim).toBe(earned.claim);
  });

  it('cuts the earned issue alone where the head does not carry the held landing', async () => {
    const w = await agenfold(H.aside);

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesWaiting: 0 });
    expect((await fx.stored(w.earned)).claim).not.toBeNull();
    expect((await fx.holdOf(w.held))?.code).toBe('RELEASE_CRITERIA_UNEARNED');
  });

  it('cuts where nobody could read the head: the range check reads it again at the report', async () => {
    const w = await agenfold();
    head = { why: 'no box holding a checkout bound to this project is connected now' };

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 1, issuesWaiting: 0 });
    expect((await fx.stored(w.earned)).claim).not.toBeNull();
  });

  it('waits again on a new head that still carries it, naming the head it read', async () => {
    const w = await agenfold();
    await sweepAutomaticReleases();
    const later = '1a7e400000000000000000000000000000000162';
    H.holds[later] = [H.held, H.earned, later];
    head = { branch: 'main', sha: later };

    const result = await sweepAutomaticReleases();

    expect(result).toMatchObject({ issuesCut: 0, holdsWritten: 1 });
    expect((await fx.holdOf(w.earned))?.reason).toContain('1a7e400 of `main`');
    expect(await fx.holdHistory(w.earned)).toHaveLength(2);
  });
});
