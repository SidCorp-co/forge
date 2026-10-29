/**
 * Whether a merged issue's work is on production, on the issue page (`liveReach`) and the pulse
 * ("Closed, not on production"), answered from the releases Forge recorded shipping and the issues'
 * merge marks (owner, 2026-10-30: agents record, Forge never infers). The project's source host is
 * the one seam replaced: it counts every time it is resolved, and a GET of either view resolves it
 * never. The sid-desk shape of ISS-1217: work lands on `staging`, production deploys from `master`.
 *
 * @direct-test-of packages/core/src/pipeline/live-reach.ts
 * @direct-test-of packages/core/src/me/pulse-live.ts
 */

import { randomUUID } from 'node:crypto';
import { saidDisagreements } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const hostResolved: string[] = [];

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async (projectId: string) => {
    hostResolved.push(projectId);
    throw new Error('a read of live reach resolved the source host');
  },
}));

const SHIPPED_AT = 'c'.repeat(40);
const LANDED = 'd'.repeat(40);

type Reach = {
  state: 'on_live' | 'not_on_live' | 'unrecorded';
  release?: { version: string; commit: string };
  cause?: string;
  why?: string;
  missing?: string;
  owes?: string;
} | null;

let token: string;
let userId: string;

beforeEach(async () => {
  await truncateAll();
  hostResolved.length = 0;
  const user = await createTestUser({ verified: true });
  userId = user.id;
  token = await userToken(user.id);
});

/** A project whose work lands on `staging` and reaches production by a merge into `master`, or one with no promotion. */
async function project(kind: 'promote' | 'publish') {
  const p = await createTestProject(userId);
  await addProjectMember(p.id, userId, 'admin');
  await seedProjectDocument(p.id, userId, {
    defaultBranch: 'staging',
    source: {
      type: 'git',
      git: {
        repository: 'github.com/SidCorp-co/sid-desk',
        defaultBranch: 'staging',
        branches: kind === 'promote' ? ['staging', 'master'] : ['staging'],
      },
    },
    promotions: kind === 'promote' ? [{ from: 'staging', to: 'master', via: 'merge' }] : [],
    environments: {
      live: {
        tier: 'production',
        deploysFrom: kind === 'promote' ? 'master' : 'staging',
        deployment: { mode: 'external' },
      },
    },
  });
  return p;
}

/** An issue landed `daysAgo` days ago at LANDED (or never, where `merged` is false). */
async function issue(args: {
  projectId: string;
  seq: number;
  status?: string;
  daysAgo?: number;
  merged?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha)
    VALUES (${id}, ${args.projectId}, ${args.seq}, ${`ISS-${args.seq}`}, ${args.status ?? 'closed'},
            ${userId},
            ${args.merged === false ? null : sql`now() - make_interval(days => ${args.daysAgo ?? 1})`},
            ${args.merged === false ? null : LANDED})
  `);
  return id;
}

/** A release cut `daysAgo` days ago naming `issueIds`, which shipped (or is still at work). */
async function release(args: {
  projectId: string;
  version: string;
  daysAgo: number;
  issueIds: string[];
  shipped?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const shipped = args.shipped !== false;
  const meta = {
    source: 'release-batch',
    issueIds: args.issueIds,
    ...(shipped ? { finish: { state: 'finished', commit: SHIPPED_AT } } : {}),
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, created_at, started_at, release_version,
                               release_released_at, metadata)
    VALUES (${id}, ${args.projectId}, 'system', ${shipped ? 'completed' : 'running'},
            now() - make_interval(days => ${args.daysAgo}), now() - make_interval(days => ${args.daysAgo}),
            ${args.version}, ${shipped ? sql`now() - make_interval(days => ${args.daysAgo})` : null},
            ${JSON.stringify(meta)}::jsonb)
  `);
  return id;
}

async function get<T>(path: string): Promise<T> {
  const res = await api(token, 'GET', path);
  expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as T;
}

const reachOf = async (id: string) =>
  (await get<{ liveReach: Reach }>(`/api/issues/${id}`)).liveReach;
const pulse = () => get<PulseResponse>('/api/me/pulse');

describe('live reach is read from the releases Forge recorded, and asks no host', () => {
  it('places a shipped issue on production, one landed after the newest release off it, and resolves no source host', async () => {
    const p = await project('promote');
    const shipped = await issue({ projectId: p.id, seq: 1, daysAgo: 5 });
    const late = await issue({ projectId: p.id, seq: 2, daysAgo: 1 });
    await release({ projectId: p.id, version: '1.4.0', daysAgo: 3, issueIds: [shipped] });

    expect(await reachOf(shipped)).toMatchObject({
      state: 'on_live',
      release: { version: '1.4.0' },
    });
    const off = await reachOf(late);
    expect(off).toMatchObject({ state: 'not_on_live' });
    expect(off?.why).toContain('after 1.4.0 (the newest release shipped');
    expect(off?.owes).toContain('a release naming it: it was closed outside one');

    const read = await pulse();
    expect(read.work.notOnLive.shown.map((i) => i.issueRef)).toEqual(['ISS-2']);
    expect(read.work.notOnLive.shown[0]).toMatchObject({ deploysFrom: 'master', commit: LANDED });
    expect(read.work.liveUnmeasured.total).toBe(0);
    expect(hostResolved).toEqual([]);
  });

  it('never reads an issue no shipped release names as live: it names the missing record and who owes it', async () => {
    const p = await project('promote');
    const unnamed = await issue({ projectId: p.id, seq: 3, daysAgo: 5 });
    const waiting = await issue({
      projectId: p.id,
      seq: 4,
      daysAgo: 5,
      status: 'awaiting_release',
    });
    await release({ projectId: p.id, version: '1.4.0', daysAgo: 3, issueIds: [] });

    const closed = await reachOf(unnamed);
    expect(closed).toMatchObject({ state: 'unrecorded', cause: 'not_named' });
    expect(closed?.missing).toBe(
      'a record of which release holds its landing: 1.4.0 was cut after it landed and does not name it',
    );
    expect(closed?.owes).toContain('no door records it for a `closed` issue');
    expect((await reachOf(waiting))?.owes).toContain('POST /api/projects/:id/shipped-in-records');

    const read = await pulse();
    expect(read.work.notOnLive.total).toBe(0);
    expect(read.work.liveUnmeasured.shown).toEqual([
      expect.objectContaining({ slug: p.slug, deploysFrom: 'master' }),
    ]);
    expect(read.work.liveUnmeasured.shown[0]?.says.reason.key).toBe('pulse.gap.unrecordedOne');
    expect(saidDisagreements(read.work.liveUnmeasured.shown)).toEqual([]);
    expect(hostResolved).toEqual([]);
  });

  it('says a project with no release shipped through Forge has no record placing its closed work', async () => {
    const p = await project('promote');
    const a = await issue({ projectId: p.id, seq: 5, daysAgo: 2 });
    await issue({ projectId: p.id, seq: 6, daysAgo: 2 });

    expect(await reachOf(a)).toMatchObject({ state: 'unrecorded', cause: 'no_release' });
    const gap = (await pulse()).work.liveUnmeasured.shown[0];
    expect(gap?.says.reason).toMatchObject({
      key: 'pulse.gap.noRelease',
      vars: { n: 2, live: 'master' },
    });
    expect(hostResolved).toEqual([]);
  });

  it('holds an issue a release still at work carries off production until that release ships', async () => {
    const p = await project('promote');
    const id = await issue({ projectId: p.id, seq: 7, daysAgo: 2, status: 'awaiting_release' });
    const run = await release({
      projectId: p.id,
      version: '1.5.0',
      daysAgo: 1,
      issueIds: [id],
      shipped: false,
    });
    await db.execute(sql`UPDATE issues SET release_batch_run_id = ${run} WHERE id = ${id}`);

    expect(await reachOf(id)).toMatchObject({
      state: 'not_on_live',
      why: 'release 1.5.0 carries it and has not been recorded shipping',
    });
    expect(hostResolved).toEqual([]);
  });

  it('gives nothing on a project with no promotion, or for an issue with no merge mark', async () => {
    const pub = await project('publish');
    const onPublish = await issue({ projectId: pub.id, seq: 8 });
    const promote = await project('promote');
    const unmerged = await issue({
      projectId: promote.id,
      seq: 9,
      merged: false,
      status: 'in_progress',
    });

    expect(await reachOf(onPublish)).toBeNull();
    expect(await reachOf(unmerged)).toBeNull();
    const read = await pulse();
    expect(read.work.notOnLive.total).toBe(0);
    expect(hostResolved).toEqual([]);
  });
});
