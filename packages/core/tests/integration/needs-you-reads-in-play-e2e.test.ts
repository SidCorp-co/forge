// ISS-1070 r2: two reads restructured for speed answer what they answered before.
// - The shipped release of each issue (`pipeline/release-runs.ts:shippedReleasesOf`) is read once for
//   a whole list from the runs whose rosters name the issues, where it read every shipped run once
//   per issue: each issue's answer is the one the per-issue rule (`holdingReleaseRunsSql`) gives.
// - Needs you weighs only the releases that can still wait on someone
//   (`release-list-read.ts:listReleasesInPlay`): each is summarised exactly as the whole list
//   summarises it, and the rows and decisions Needs you lists are the ones the whole list gives.
// - The newest shipped and the newest live place the draft without weighing it: each release they
//   return is the whole list's.
// @direct-test-of packages/core/src/issues/release-evidence.ts
// @direct-test-of packages/core/src/pipeline/release-runs.ts
// @direct-test-of packages/core/src/release-batch/release-list-read.ts
// @direct-test-of packages/core/src/development/needs-you.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { owedOf, readAttention, readNeedsYouAttention } from '../../src/development/needs-you.js';
import { needsYouListOf } from '../../src/development/needs-you-decisions-read.js';
import { needsYouViewerOf } from '../../src/development/needs-you-viewer.js';
import { holdingReleaseRunsSql } from '../../src/issues/index.js';
import { loadProjectAccess } from '../../src/lib/authz.js';
import { shippedReleasesOf } from '../../src/pipeline/index.js';
import {
  latestLiveReleases,
  listReleases,
  listReleasesInPlay,
} from '../../src/release-batch/index.js';
import { listShippedReleases } from '../../src/release-batch/release-list-read.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser } from '../helpers/factories.js';

let ownerId: string;
let projectId: string;
const issue: Record<string, string> = {};
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function run(
  version: string,
  status: string,
  released: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${projectId}, 'system', ${status}, ${released ?? at(1)}, ${released},
            ${version}, ${released}, ${JSON.stringify({ source: 'release-batch', ...metadata })}::jsonb)`);
}

async function move(issueId: string, from: string | null, to: string, when: string): Promise<void> {
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', 'human', ${ownerId}, 'test', ${when})`),
  );
}

/** The release the per-issue rule names for one issue: the newest shipped run holding its work. */
async function perIssue(issueId: string): Promise<{ version: string; at: string } | undefined> {
  const [row] = (await db.execute(sql`
    SELECT h.release_version AS version, h.release_released_at AS at
      FROM (${holdingReleaseRunsSql(sql`${issueId}`, sql`${projectId}::uuid`)}) h
     ORDER BY h.release_released_at DESC LIMIT 1`)) as unknown as {
    version: string;
    at: string | Date;
  }[];
  return row ? { version: row.version, at: new Date(row.at).toISOString() } : undefined;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const names = [
    'plain',
    'twice',
    'unclosed',
    'closedLater',
    'superseded',
    'reopened',
    'reopenUndone',
    'scalar',
    'never',
    'waiting',
  ];
  for (const [n, name] of names.entries()) {
    issue[name] = (
      await createTestIssue(projectId, ownerId, n + 1, {
        status: name === 'waiting' ? 'awaiting_release' : 'closed',
        createdAt: new Date(at(30)),
        mergedAt: new Date(at(30)),
      })
    ).id;
  }
  const i = issue as Record<(typeof names)[number], string>;
  // shipped releases, oldest first
  await run('1.0.0', 'completed', at(20), { issueIds: [i.plain, i.twice, i.reopened] });
  await run('1.1.0', 'completed', at(15), {
    issueIds: [i.twice, i.unclosed, i.superseded, i.reopenUndone],
    rosterUnclosed: [i.unclosed],
    rosterSuperseded: [i.superseded],
  });
  await run('1.2.0', 'completed', at(10), { issueIds: [], rosterClosed: [i.closedLater] });
  await run('1.3.0', 'completed', at(9), { issueIds: i.scalar });
  // releases that did not ship, and so hold nothing
  await run('1.4.0', 'failed', null, { issueIds: [i.never] });
  await run('1.5.0', 'failed', null, { issueIds: [i.never], abort: { reason: 'stopped' } });
  await run('1.6.0', 'running', null, { issueIds: [i.never] });
  // its approval asked and undecided: the release waits on the viewer, who holds releases.approve
  await db.execute(sql`
    INSERT INTO release_approvals (project_id, run_id, requested_by_user, evidence_commit, evidence_reading)
    SELECT ${projectId}, id, ${ownerId}, ${'c'.repeat(40)}, 'served' FROM pipeline_runs
     WHERE project_id = ${projectId} AND release_version = '1.6.0'`);
  // reopened after 1.0.0 shipped it: its work was rejected
  await move(i.reopened, 'closed', 'reopen', at(18));
  // reopened after 1.1.0 and straight back: the reopen undone, 1.1.0 still holds it
  await move(i.reopenUndone, 'closed', 'reopen', at(14));
  await move(i.reopenUndone, 'reopen', 'closed', at(13));
}, 120_000);

afterAll(closeWorld);

describe('the shipped release of each issue, read once for the whole list', () => {
  it('names for every issue the release the per-issue rule names, and none where it names none', async () => {
    const ids = Object.values(issue);
    const read = await shippedReleasesOf(projectId, ids);
    const expected = new Map<string, { version: string; at: string }>();
    for (const id of ids) {
      const one = await perIssue(id);
      if (one) expected.set(id, one);
    }
    expect(read).toEqual(expected);
    // the cases each answer what the rule says, not only what the other read says
    const version = (name: string) => read.get(issue[name] as string)?.version;
    expect(version('plain')).toBe('1.0.0');
    expect(version('twice')).toBe('1.1.0');
    expect(version('unclosed')).toBeUndefined();
    expect(version('closedLater')).toBe('1.2.0');
    expect(version('superseded')).toBeUndefined();
    expect(version('reopened')).toBeUndefined();
    expect(version('reopenUndone')).toBe('1.1.0');
    expect(version('scalar')).toBe('1.3.0');
    expect(version('never')).toBeUndefined();
  });

  it('answers a list of one as it answers the issue inside the whole list', async () => {
    const one = await shippedReleasesOf(projectId, [issue.twice as string]);
    expect([...one.values()].map((r) => r.version)).toEqual(['1.1.0']);
  });
});

describe('Needs you weighs only the releases that can still wait on someone', () => {
  it('summarises each such release as the whole list does, and leaves out only the shipped, failed and aborted', async () => {
    const access = await loadProjectAccess(projectId, ownerId);
    const viewer = needsYouViewerOf(access, ownerId, 'human');
    const all = (await listReleases(projectId, viewer)).releases;
    const inPlay = (await listReleasesInPlay(projectId, viewer)).releases;
    const ended = new Set(['shipped', 'failed', 'aborted']);
    expect(all.some((r) => ended.has(r.state))).toBe(true);
    expect(inPlay.length).toBeGreaterThan(0);
    expect(inPlay).toEqual(all.filter((r) => !ended.has(r.state)));
    // the draft is weighed: the gate standing against its cut (no release target declared) is read
    expect(inPlay.find((r) => r.state === 'draft')?.waitingOn.says.act.key).toBe(
      'standing.act.declareTarget',
    );
  });

  it('lists the same owed rows and decisions from either read', async () => {
    const access = await loadProjectAccess(projectId, ownerId);
    const viewer = needsYouViewerOf(access, ownerId, 'human');
    const now = new Date();
    const whole = await readAttention(projectId, viewer, now);
    const inPlay = await readNeedsYouAttention(projectId, viewer, now);
    // a release waits on the viewer here, so the release rows are compared, not two empty lists
    expect(owedOf(whole.rows).releases.map((r) => r.key)).not.toEqual([]);
    expect(owedOf(inPlay.rows)).toEqual(owedOf(whole.rows));
    const fromWhole = await needsYouListOf(projectId, viewer, access, whole, now);
    const fromInPlay = await needsYouListOf(projectId, viewer, access, inPlay, now);
    // the release's decision is built, and left to the master as a routine one (REQ-68 BC-3)
    expect(fromWhole.left.get('agent_takes')?.map((t) => t.key)).toEqual(['1.6.0']);
    expect(fromInPlay.decisions).toEqual(fromWhole.decisions);
    expect([...fromInPlay.left]).toEqual([...fromWhole.left]);
  });
});

describe('the newest shipped and the newest live place the draft without weighing it', () => {
  it('return the releases the whole list returns, each summarised as it summarises them', async () => {
    const all = (await listReleases(projectId, null)).releases;
    expect(all.some((r) => r.state === 'draft')).toBe(true);
    const wentOut = all
      .filter((r) => r.releasedAt !== null)
      .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''));
    expect((await listShippedReleases(projectId, null, 3)).releases).toEqual(wentOut.slice(0, 3));
    const live = (await latestLiveReleases(projectId)).releases;
    expect(live).toEqual([wentOut.find((r) => r.state === 'shipped')]);
  });
});
