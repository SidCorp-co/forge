/**
 * ISS-1217 — the sid-desk reproduction against real rows: closed issues whose commits sit on
 * `staging` and not on `master`. The project's source host is the one seam replaced
 * (`integrations/source-host/resolve.ts:resolveSourceHost`), answering a divergence the way a host
 * does; the release path, the reading's hold, the ownership rules, the issue routes and the pulse
 * are the app's own, over Postgres.
 */

import { randomUUID } from 'node:crypto';
import { type Said, saidDisagreements } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { LiveDivergence, WaitingCommit } from '../../src/integrations/source-host/index.js';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import { consumerOf } from '../../src/outbox/consumers.js';
import { registerLiveReadingInvalidation } from '../../src/projects/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** The keys of the gaps a pulse reason says, one or several joined (`pulse.gap.all`). */
const gapKeys = (s: Said | undefined): string[] =>
  s?.key === 'pulse.gap.all'
    ? ((s.vars?.parts ?? []) as Said[]).map((p) => p.key)
    : s
      ? [s.key]
      : [];

const STAGING = 'f'.repeat(40);
const MASTER = '52c66950'.padEnd(40, '0');
const OBSERVED = '11d071b3'.padEnd(40, '0');
const NOT_LIVE = [419, 423, 429, 432, 434, 435, 440, 442];

const commit = (sha: string, message: string, parents: string[] = []): WaitingCommit => ({
  sha,
  message,
  parents,
});

/** Seven commits naming their keys, some citing the shipped ISS-400 in passing, one naming none. */
const SID_DESK: WaitingCommit[] = [
  ...NOT_LIVE.filter((n) => n !== 442).map((n, i) =>
    commit(
      `${String(i + 1).padStart(2, '0')}`.padEnd(40, 'a'),
      i % 2
        ? `fix(desk): change (ISS-${n})\n\nkeeps the shape the ISS-400 decision chose`
        : `Merge pull request #${n} from sid/ISS-${n}-slug`,
    ),
  ),
  commit(OBSERVED, 'a squash whose message names no issue'),
];

let waiting: WaitingCommit[] = SID_DESK;
let aheadOverride: number | null = null;
let compares = 0;
const unbound = new Set<string>();

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>();
  const { SourceHostUnavailable: Unavailable } = await import(
    '../../src/integrations/source-host/errors.js'
  );
  return {
    ...real,
    resolveSourceHost: async (projectId: string) => {
      if (unbound.has(projectId)) {
        throw new Unavailable('no_binding', 'this project has no active source host binding');
      }
      return {
        readDivergence: async (refs: {
          baseRef: string;
          liveRef: string;
        }): Promise<LiveDivergence> => {
          compares += 1;
          expect(refs).toEqual({ baseRef: 'staging', liveRef: 'master' });
          const aheadBy = aheadOverride ?? waiting.length;
          return {
            ok: true,
            baseSha: STAGING,
            liveSha: MASTER,
            aheadBy,
            commits: waiting,
            complete: aheadBy <= waiting.length,
          };
        },
      };
    },
  };
});

type Reach = {
  state: string;
  evidence?: Array<{ sha: string; via: string }>;
  unowned?: Array<{ sha: string }>;
  reason?: string;
} | null;

let token: string;
let userId: string;

beforeEach(async () => {
  await truncateAll();
  waiting = SID_DESK;
  aheadOverride = null;
  compares = 0;
  unbound.clear();
  const user = await createTestUser({ verified: true });
  userId = user.id;
  token = await userToken(user.id);
});

/** A project whose work lands on `staging` and reaches production by a merge into `master`, or one with no promotion. */
async function project(kind: 'promote' | 'publish', repository = 'github.com/SidCorp-co/sid-desk') {
  const p = await createTestProject(userId);
  await addProjectMember(p.id, userId, 'admin');
  await seedProjectDocument(p.id, userId, {
    defaultBranch: 'staging',
    source: {
      type: 'git',
      git: {
        repository,
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

async function issue(args: {
  projectId: string;
  seq: number;
  status?: string;
  merged?: boolean;
  sha?: string;
  head?: string;
}): Promise<string> {
  const id = randomUUID();
  const context = args.head
    ? { worklog: { head: args.head, base: MASTER, branch: `iss-${args.seq}` } }
    : null;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, session_context)
    VALUES (${id}, ${args.projectId}, ${args.seq}, ${`ISS-${args.seq}`}, ${args.status ?? 'closed'},
            ${userId}, ${args.merged === false ? null : sql`now() - interval '1 day'`},
            ${args.sha ?? null}, ${context ? JSON.stringify(context) : null}::jsonb)
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

describe('a closed issue whose work never reached the live branch (ISS-1217)', () => {
  it('places each of the eight rows off master, by key and by its own merge, and counts them in the pulse', async () => {
    const desk = await project('promote');
    const ids = new Map<number, string>();
    for (const n of NOT_LIVE) {
      ids.set(
        n,
        await issue({ projectId: desk.id, seq: n, ...(n === 442 ? { sha: OBSERVED } : {}) }),
      );
    }
    const shipped = await issue({ projectId: desk.id, seq: 400 });

    for (const n of NOT_LIVE)
      expect((await reachOf(String(ids.get(n))))?.state, `ISS-${n}`).toBe('not_on_live');
    expect((await reachOf(String(ids.get(442))))?.evidence).toEqual([
      expect.objectContaining({ sha: OBSERVED, via: 'merged_commit' }),
    ]);
    expect((await reachOf(String(ids.get(423))))?.evidence).toEqual([
      expect.objectContaining({ via: 'declares_issue' }),
    ]);
    expect(await reachOf(shipped)).toMatchObject({
      state: 'none_waiting',
      baseBranch: 'staging',
      deploysFrom: 'master',
      baseSha: STAGING,
      liveSha: MASTER,
      unowned: [],
    });

    const read = await pulse();
    expect(read.work.notOnLive.total).toBe(8);
    expect(read.work.notOnLive.shown.map((i) => i.issueRef).sort()).toEqual(
      NOT_LIVE.map((n) => `ISS-${n}`).sort(),
    );
    expect(read.work.liveUnmeasured.total).toBe(0);
  });

  it('counts only closed rows in the pulse, and gives nothing on a project with no promotion or an unmerged row', async () => {
    const desk = await project('promote');
    const other = await project('publish');
    await issue({ projectId: desk.id, seq: 419, status: 'awaiting_release' });
    const open = await issue({ projectId: desk.id, seq: 423, status: 'open', merged: false });
    const elsewhere = await issue({ projectId: other.id, seq: 429 });

    expect(await reachOf(open)).toBeNull();
    expect(await reachOf(elsewhere)).toBeNull();
    expect((await pulse()).work.notOnLive.total).toBe(0);
  });

  it('names a promote project Forge cannot compare, and says why on its rows', async () => {
    const desk = await project('promote', 'gitlab.com/thanhnguyen21/sid-desk');
    unbound.add(desk.id);
    const row = await issue({ projectId: desk.id, seq: 419 });
    const reason =
      "Forge holds no source host binding for this project's repository on gitlab.com, so it cannot read the branches — bind the repository's host on its Integrations page";

    expect(await reachOf(row)).toMatchObject({ state: 'unmeasured', reason });
    const read = await pulse();
    expect(read.work.liveUnmeasured.shown).toEqual([
      expect.objectContaining({ id: desk.id, deploysFrom: 'master', reason }),
    ]);
    expect(read.work.notOnLive.total).toBe(0);
    expect(compares).toBe(0);
  });

  it('holds one reading per project, and compares again only after a push for that project', async () => {
    const desk = await project('promote');
    const row = await issue({ projectId: desk.id, seq: 419 });
    registerLiveReadingInvalidation();
    const pushed = consumerOf('source.pushed', 'live-reading');
    if (!pushed) throw new Error('the live reading registered no source.pushed consumer');

    await reachOf(row);
    await reachOf(row);
    expect(compares).toBe(1);
    await pushed.handle({ projectId: randomUUID() } as never, {} as never);
    await reachOf(row);
    expect(compares).toBe(1);
    await pushed.handle({ projectId: desk.id } as never, {} as never);
    await reachOf(row);
    expect(compares).toBe(2);
  });
});

describe('a reading that cannot place every closed issue (ISS-1217)', () => {
  it('says the list was cut short rather than calling the rest on live', async () => {
    const desk = await project('promote');
    const placed = await issue({ projectId: desk.id, seq: 419 });
    const unseen = await issue({ projectId: desk.id, seq: 777 });
    aheadOverride = 500;

    const read = await pulse();

    expect(read.work.notOnLive.total).toBe(1);
    expect(read.work.liveUnmeasured.shown[0]?.reason).toMatch(
      /500 commits ahead of master and the reading listed only 8/,
    );
    // core's own gap is said by key, so the pulse reads it in the reader's language
    expect(gapKeys(read.work.liveUnmeasured.shown[0]?.says.reason)).toContain('pulse.gap.cut');
    expect(saidDisagreements(read.work.liveUnmeasured.shown)).toEqual([]);
    expect((await reachOf(placed))?.state).toBe('not_on_live');
    expect(await reachOf(unseen)).toMatchObject({
      state: 'unmeasured',
      reason: expect.stringMatching(/may be among the ones it did not read/),
    });
  });

  it('leaves a row merged after the reading unmeasured until the next one', async () => {
    const desk = await project('promote');
    await issue({ projectId: desk.id, seq: 419 });
    await pulse();
    const later = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${later}, ${desk.id}, 900, 'merged later', 'closed', ${userId}, now() + interval '1 hour')
    `);

    expect(await reachOf(later)).toMatchObject({
      state: 'unmeasured',
      reason: expect.stringMatching(/merged after the last reading of staging against master/),
    });
    const gaps = (await pulse()).work.liveUnmeasured.shown;
    expect(gaps[0]?.reason).toMatch(/^1 closed issue merged after the reading/);
    expect(gapKeys(gaps[0]?.says.reason)).toContain('pulse.gap.lateOne');
    expect(saidDisagreements(gaps)).toEqual([]);
  });
});

describe('a merge and a recorded head place work whose commits name no key (ISS-1217 reopens 1 and 4)', () => {
  const MERGE = 'b'.repeat(40);
  const CARRIED = 'c'.repeat(40);
  const HEAD = 'd'.repeat(40);

  it('places a row on the commits its merge brought in, and never on a subject citing it in passing', async () => {
    waiting = [
      commit(MERGE, 'Merge branch iss-450 into staging (ISS-450)', [MASTER, CARRIED]),
      commit(CARRIED, 'tidy the desk', [MASTER]),
      commit('e'.repeat(40), 'docs: as ISS-400 decided, nothing else'),
    ];
    const desk = await project('promote');
    const merged = await issue({ projectId: desk.id, seq: 450 });
    const cited = await issue({ projectId: desk.id, seq: 400 });

    const reach = await reachOf(merged);
    expect(reach?.state).toBe('not_on_live');
    expect(reach?.evidence?.map((e) => e.sha).sort()).toEqual([MERGE, CARRIED].sort());
    expect(await reachOf(cited)).toMatchObject({ state: 'none_waiting' });
  });

  it("places a row on its run's recorded head, and names the waiting commits nobody owns", async () => {
    waiting = [
      commit(HEAD, 'fast-forwarded work'),
      commit('a'.repeat(40), 'someone else, unnamed'),
    ];
    const portal = await project('promote');
    const recorded = await issue({ projectId: portal.id, seq: 71, head: HEAD });
    const other = await issue({ projectId: portal.id, seq: 72 });

    expect(await reachOf(recorded)).toMatchObject({
      state: 'not_on_live',
      evidence: [expect.objectContaining({ sha: HEAD, via: 'recorded_head' })],
    });
    expect(await reachOf(other)).toMatchObject({
      state: 'none_waiting',
      unowned: [expect.objectContaining({ sha: 'a'.repeat(40) })],
    });
  });
});
