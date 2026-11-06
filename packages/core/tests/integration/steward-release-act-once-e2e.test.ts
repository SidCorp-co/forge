/**
 * ISS-1040: an issue whose every criterion is earned, on a project with production, owes nothing of
 * its own: the release carrying it holds the act that ships it, once for every issue it carries.
 * Planted from adminhub-api on 2026-11-06: after ISS-1035 the steward read ISS-41, ISS-65 and ISS-66
 * all earned, was told only "Every live criterion is earned", and asked the master once per issue to
 * cut or approve 0.14.0, a master holding no releases.approve, while 0.14.0's own standing already
 * held the act. Here three all-earned issues sit in one draft of a project promoted to production:
 * the facts name that release and its wait, and three runs asking about the three issues raise one
 * ask, on the release, of whoever takes its act, and none on an issue.
 *
 * @direct-test-of packages/core/src/release-batch/criteria-facts.ts
 * @direct-test-of packages/core/src/release-batch/carrying-release.ts
 * @direct-test-of packages/core/src/steward/release-ask.ts
 * @direct-test-of packages/core/src/steward/door-wake.ts
 * @direct-test-of packages/core/src/steward/asks.ts
 * @direct-test-of packages/core/src/steward/sweep.ts
 * @direct-test-of packages/core/src/steward/prompts.ts
 * @direct-test-of packages/core/src/development/needs-you-agent-takes.ts
 * @direct-test-of packages/core/src/steward-ports.ts
 * @direct-test-of packages/core/src/steward/ports.ts
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 */

import type { WaitingOn } from '@forge/contracts/standing';
import type { ItemStanding } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';
import { seedProjectDocument } from '../helpers/release-world.js';

/** The source host, answering every landing as an ancestor of what stg serves. */
const H = vi.hoisted(() => {
  const files = { files: ['app/Http/Kernel.php'], changes: [] };
  return {
    host: {
      fullName: 'sidcorp-it/adminhub-api',
      compare: async () => 'ahead',
      compareFiles: async () => ({ status: 'diverged', ...files }),
      commitFiles: async () => files,
    },
  };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host,
}));

const STG_PROBE = 'https://stg-adminhub-api.example.test/api/v1/build-info';
const SERVED = '0076d673515fdb24a01de5af5d8ab1e448c156aa';
/** ISS-41, ISS-65 and ISS-66's landings on release/stg. */
const LANDINGS = [
  '41a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3',
  '65b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
  '66c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5',
];

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let masterId = '';
let seq = 40;
const standings: ItemStanding[] = [];

/** adminhub-api's document: lands on `release/stg`, promoted to `release/production`, judged on stg. */
async function adminhubApi(profile: 'standard' | 'strict'): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    defaultBranch: 'release/stg',
    promotions: [{ from: 'release/stg', to: 'release/production', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        url: 'https://stg-adminhub-api.example.test',
        verification: {
          runtime: [{ type: 'http', url: STG_PROBE, path: 'commit', identifies: 'source' }],
        },
      },
      production: {
        tier: 'production',
        deploysFrom: 'release/production',
        deployment: { mode: 'external' },
        url: 'https://adminhub-api.example.test',
      },
    } as never,
    extra: {
      release: { approval: { required: true }, changeRequests: false },
      delivery: { verdictsRequired: true, judgedOn: 'stg' },
      gates: { profile },
    } as never,
  });
}

/** An issue landed at `landing` on release/stg, at awaiting_release, its three criteria passed there at runtime. */
async function earnedIssue(landing: string): Promise<{ id: string; key: string }> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${projectId}, ${seq}, ${`Landed work ${seq}`}, 'in_progress', ${ownerId},
            now() - interval '1 minute', ${landing}, 'release/stg')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(
    id,
    [1, 2, 3].map((n) => ({ n, statement: `Criterion ${n} holds on stg.` })),
  );
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                    runtime_ref, author_user_id, author_agency, judge)
    SELECT id, ${id}, 'pass', 'Called the route on stg.', 'runtime', ${landing},
           ${ownerId}, 'agent', 'qa'
      FROM issue_criteria WHERE issue_id = ${id} AND retired_at IS NULL
  `);
  await seedIssueStatus(id, 'awaiting_release');
  return { id, key: `ISS-${seq}` };
}

/** The steward's run on the issue, as an output check opens one when it enters awaiting_release. */
async function runOn(issue: { id: string; key: string }): Promise<string> {
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, basis, not_before, started_at)
    VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'release.asked', '[]'::jsonb,
            ARRAY['output_check']::text[], 'running', ${`landed-${issue.key}`}, now(), now())
    RETURNING id`);
  return made?.id as string;
}

/** The ask the adminhub-api steward made of each issue, through the real wake door. */
async function askAbout(issue: { id: string; key: string }) {
  const { callStewardDoor } = await import('../../src/steward/doors.js');
  return callStewardDoor(
    'steward_wake_master',
    JSON.stringify({
      about: issue.key,
      ask: `Cut or approve the production release that carries ${issue.key}.`,
    }),
    {
      projectId,
      runId: await runOn(issue),
      act: 'output_check',
      subject: { kind: 'issue', id: issue.id, key: issue.key },
      standing: null,
      token: '',
      refused: [],
      broken: [],
      acts: [],
    },
  );
}

interface AskRead {
  door: string;
  did: string;
  master_ask: string | null;
  wrote: { kind: string; ref: string } | null;
}
const asks = () =>
  rows<AskRead>(sql`
    SELECT door, did, master_ask, wrote FROM steward_acts
     WHERE project_id = ${projectId} ORDER BY at, id`);

/** The draft's own standing, as GET /api/projects/:id/releases lists it. */
async function draft(): Promise<{ version: string; state: string; waitingOn: WaitingOn }> {
  const list = ok(await say('owner', 'GET', `/api/projects/${projectId}/releases`)) as {
    releases: Array<{ version: string; state: string; waitingOn: WaitingOn }>;
  };
  const found = list.releases.find((r) => r.state === 'draft');
  if (!found) throw new Error(`no draft release: ${JSON.stringify(list.releases)}`);
  return found;
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  say = requester(app, { owner: await signUserToken(ownerId) });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(STG_PROBE)) return Response.json({ commit: SERVED });
    return real(input, init);
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeWorld();
});

/** A fresh adminhub-api with its master: an agent member writing it from a paired box, holding no releases.approve. */
async function project(profile: 'standard' | 'strict'): Promise<void> {
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  masterId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, masterId, 'member');
  await pairTestBox(projectId, { pairedBy: masterId, actsAs: masterId });
  await adminhubApi(profile);
}

describe('three all-earned issues in one draft on a project with production (adminhub-api 0.14.0)', () => {
  let issues: Array<{ id: string; key: string }> = [];
  let release: Awaited<ReturnType<typeof draft>>;

  beforeAll(async () => {
    await project('standard');
    issues = [];
    for (const landing of LANDINGS) issues.push(await earnedIssue(landing));
    release = await draft();
  });

  it("each issue's facts name the draft carrying it and its wait, and ask nothing on the issue", async () => {
    const { stewardReleaseFacts } = await import('../../src/release-batch/index.js');
    for (const issue of issues) {
      const said = await stewardReleaseFacts(projectId, issue.id);
      expect(said).toContain('Every live criterion is earned');
      expect(said).toContain(`It ships with release ${release.version} (draft)`);
      expect(said).toContain(
        `release ${release.version} (draft) waits on ${release.waitingOn.who}${release.waitingOn.act ? ` to ${release.waitingOn.act}` : ''}`,
      );
      expect(said).toContain('Nothing is asked on this issue');
    }
  });

  it('three runs asking about the three issues raise one ask, on the release, of whoever takes its act', async () => {
    const answers = [];
    for (const issue of issues) answers.push(await askAbout(issue));
    expect(answers.map((a) => a.ok)).toEqual([true, false, false]);
    for (const later of answers.slice(1)) {
      expect(later.text).toContain(`ships with release ${release.version} (draft)`);
      expect(later.text).toContain('raised on it on this wait');
    }
    const made = await asks();
    expect(made).toHaveLength(1);
    expect(made[0]?.wrote).toEqual({ kind: 'release', ref: release.version });
    // the draft's own standing names who takes its act: the master, for a gate act or the cut it takes
    expect(release.waitingOn.kind === 'agent' || release.waitingOn.kind === 'person').toBe(true);
    expect(made[0]).toMatchObject({ door: 'WAKE master.wake steward' });
    expect(made[0]?.master_ask).toContain(`${issues[0]?.key}: Release ${release.version}:`);
    // none on an issue
    const onIssues = made.filter((a) => issues.some((i) => i.key === a.wrote?.ref));
    expect(onIssues).toEqual([]);
  });

  it("the master's nudge holds the one ask, answered by a decision on the issue whose run raised it", async () => {
    const { openStewardAsks } = await import('../../src/steward/index.js');
    const open = await openStewardAsks(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]?.subject).toEqual({ kind: 'issue', key: issues[0]?.key });
    expect(open[0]?.answeredOn).toEqual([{ kind: 'issue', key: issues[0]?.key }]);
    const { sweepStandings } = await import('../../src/steward/index.js');
    // the release's wait has not moved, so the sweep keeps it standing
    expect((await sweepStandings(new Date())).settledAsks).toBe(0);
    expect(await openStewardAsks(projectId)).toHaveLength(1);
  });
});

/**
 * A gate-free draft's wait on its cut, as its page says it to nobody in particular: the release
 * view's own turn, given whether the project's master cuts by the reading the page takes.
 */
async function cutWait(): Promise<WaitingOn> {
  const { turnOf } = await import('../../src/release-batch/release-view.js');
  // the release module's own reading of whether the master cuts, as the page takes it
  const { masterCutsReleases } = await import('../../src/release-batch/provider-live.js');
  const { holderNames } = await import('../../src/permissions/index.js');
  return turnOf({
    state: 'draft',
    version: '0.14.0',
    projectId,
    runId: null,
    merges: null,
    landedOn: null,
    required: true,
    approval: null,
    approvers: [],
    admins: await holderNames('project.admin', projectId),
    masterCuts: await masterCutsReleases(projectId),
    viewer: null,
    gates: [],
    inFlight: null,
    testing: null,
  }).waitingOn as WaitingOn;
}

/** A release's wait on a person's approval, as its page says it (`release-view.ts:approvalTurn`). */
function personWait(act: 'standing.act.approve', name: string): WaitingOn {
  return {
    kind: 'person',
    who: name,
    act: 'approve',
    rule: 'the release waits on a person',
    ref: null,
    dueAt: null,
    says: {
      who: { key: 'standing.who.named', vars: { name } },
      act: { key: act },
      rule: { key: 'releases.rule.asked' },
    } as never,
  };
}

describe('a release act the master cannot take goes to whoever holds it, never the master', () => {
  let ownerName = '';

  beforeAll(async () => {
    await project('standard');
    const { holderNames } = await import('../../src/permissions/index.js');
    ownerName = (await holderNames('releases.approve', projectId)).join(', ');
  });

  it('a release waiting on its approval, which the master does not hold, asks the releases.approve holders by name', async () => {
    const issue = await earnedIssue('77d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6');
    const { stewardPorts, provideStewardPorts } = await import('../../src/steward/ports.js');
    const given = stewardPorts();
    const wait = personWait('standing.act.approve', ownerName);
    const line = `release 0.14.0 (awaiting approval) waits on ${ownerName} to approve`;
    provideStewardPorts({
      ...given,
      releaseHoldingAct: async (_p, id) =>
        id === issue.id
          ? {
              version: '0.14.0',
              state: 'awaiting_approval',
              waitingOn: wait,
              since: new Date().toISOString(),
              line,
            }
          : given.releaseHoldingAct(_p, id),
    });
    try {
      expect((await askAbout(issue)).ok).toBe(true);
    } finally {
      provideStewardPorts(given);
    }
    const made = await asks();
    expect(made.map((a) => [a.door, a.master_ask, a.wrote])).toEqual([
      ['NOTIFY release holders', null, { kind: 'release', ref: '0.14.0' }],
    ]);
    expect(made[0]?.did).toContain(
      `Asked the releases.approve holders (${ownerName}) about ${line}`,
    );
  });

  it("the cut is the master's outside strict, and its admins' under strict, never a master who cannot cut", async () => {
    const { releaseTakerOf } = await import('../../src/steward/release-ask.js');
    // whom the cut goes to is read off a gate-free draft's own page, the one answer (ISS-1043)
    const standard = await cutWait();
    expect(standard).toMatchObject({ kind: 'agent', who: 'Master', act: 'cut 0.14.0' });
    expect(await releaseTakerOf(projectId, standard, null)).toEqual({ to: 'master' });
    await project('strict');
    const strict = await cutWait();
    expect(strict).toMatchObject({ kind: 'person', act: 'cut 0.14.0' });
    expect(await releaseTakerOf(projectId, strict, null)).toMatchObject({
      to: 'holders',
      holders: [{ id: ownerId }],
    });
  });
});
