/**
 * ISS-1058: one rule says who owes an act (`@forge/contracts/who-owes:whoOwes`). Planted from
 * catalog-api and catalog-fe on 2026-11-06: their releases read `waitingOn {kind:'you'}` for a split
 * over the cap and a landing to record, the per-project Needs you listed 16 acts as the owner's while
 * the org Activity listed none for the same project, and no master was placed because nothing
 * counted the acts as its work. Here, on a project with no master at all:
 *
 * - a routine release act names the master on the release, is absent from the owner's Needs you and
 *   Activity alike, and is the master's owed work on a box's sweep, so a master is placed for it;
 * - a release carrying what cannot be undone (a migration dropping a table) names the owner on both;
 * - a project whose own policy keeps a person's gate on keeps that act the person's;
 * - a resolved report a person's account filed (an automated check under the owner's login) owes its
 *   confirm to the master, not to the reporter's "you".
 *
 * @direct-test-of packages/contracts/src/who-owes.ts
 * @direct-test-of packages/core/src/project-config/owed-policy.ts
 * @direct-test-of packages/core/src/release-batch/release-owes.ts
 * @direct-test-of packages/core/src/release-batch/release-gates.ts
 * @direct-test-of packages/core/src/release-batch/release-view.ts
 * @direct-test-of packages/core/src/release-batch/master-owed-acts.ts
 * @direct-test-of packages/core/src/development/needs-you-agent-takes.ts
 * @direct-test-of packages/core/src/development/needs-you-decisions-read.ts
 * @direct-test-of packages/core/src/feedback/standing.ts
 * @direct-test-of packages/core/src/feedback/owed-verify.ts
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/activity/read.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let orgId: string;
let runnerId: string;
const tokens: Record<'owner' | 'box', string> = { owner: '', box: '' };

const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const [project] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${projectId}`,
  );
  orgId = (project as { org_id: string }).org_id;
  tokens.owner = await userToken(ownerId);
  // no agent account writes this project: no master stands, and none ever stood
  runnerId = await fx.seedReleaseRunner();
  const [runner] = await rows<{ device_id: string }>(
    sql`SELECT device_id FROM runners WHERE id = ${runnerId}`,
  );
  tokens.box = (
    await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: 'box',
      deviceId: (runner as { device_id: string }).device_id,
      projectIds: [projectId],
    })
  ).plaintext;
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

const call = async (
  who: keyof typeof tokens,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => {
  const r = await api(tokens[who], method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body as Doc;
};

const NOTE = {
  section: 'Added',
  title: 'Visit reminders',
  userFacing: 'A reminder reaches the nurse.',
};
const DROPS = 'drops the table legacy_orders';

/** The owner's view of the draft. */
const draft = async () =>
  (await call('owner', 'GET', `/api/projects/${projectId}/releases/0.1.0`)).release as Doc;

/** The owner's Needs you, as the project page reads it. */
const needsYou = () => call('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`);

/** The org Activity's row for the project, as the owner reads it. */
async function activityRow(): Promise<Doc> {
  const { readOrgActivity } = await import('../../src/activity/read.js');
  const read = await readOrgActivity(orgId, { userId: ownerId, agency: 'human' }, new Date(), {
    waitMs: 60_000,
  });
  return read.projects.find((p) => p.projectId === projectId) as unknown as Doc;
}

/** One box sweep, as it reports with no pane placed: what the master is owed. */
const sweep = () =>
  call('box', 'POST', '/api/devices/me/master-session/verdict', {
    projectId,
    runnerId,
    facts: {
      restarting: null,
      terminal: true,
      standing: 'proceed',
      pane: 'absent',
      capability: null,
      serversReadable: true,
      work: { poolWaits: false, jobPanes: 0 },
      conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
      placement: null,
      holding: { kind: 'nothing' },
      turn: { kind: 'ended' },
      idle: {
        noWorkForSeconds: 0,
        pane: null,
        children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
      },
      limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
      nudge: { last: null, since: 'unreported' },
    },
  });

const releaseDecisions = (read: Doc) =>
  (read.decisions as Doc[]).filter((d) => d.opens?.kind === 'release');

describe('a routine release act on a project with no master (ISS-1058)', () => {
  it('names the master, is absent from the owner on Needs you and Activity alike, and is the master work a box places one for', async () => {
    await fx.insertIssue('awaiting_release', NOTE);
    expect(await draft()).toMatchObject({
      attentionGroup: 'waiting',
      waitingOn: { kind: 'agent', who: 'Master', act: 'cut 0.1.0' },
      irreversible: [],
    });
    const read = await needsYou();
    expect(releaseDecisions(read), 'the cut reached the owner as a decision').toEqual([]);
    const row = await activityRow();
    expect(row.people.total, 'Activity counted the cut as the owner’s').toBe(0);
    expect(row.group).not.toBe('you');
    // the two surfaces give one answer: neither lists it as the owner's
    expect(read.total).toBe(row.people.total);
    const swept = await sweep();
    expect(swept.work.owed, 'nothing counted the cut as the master’s work').toBeGreaterThan(0);
    expect(swept.work.owedLine).toContain('0.1.0: cut 0.1.0');
  });
});

describe('an irreversible release act (ISS-1058)', () => {
  it('names the owner on the release, on Needs you and on Activity, and is no master work', async () => {
    await fx.insertIssue('awaiting_release', { ...NOTE, irreversible: DROPS });
    expect(await draft()).toMatchObject({
      attentionGroup: 'needs_you',
      waitingOn: { kind: 'you', act: 'cut 0.1.0' },
      irreversible: [DROPS],
    });
    const read = await needsYou();
    expect(releaseDecisions(read)).toHaveLength(1);
    const row = await activityRow();
    expect(row.people.total).toBe(1);
    expect(row.group).toBe('you');
    expect(read.total).toBe(row.people.total);
    const swept = await sweep();
    expect(swept.work.owedLine).not.toContain('cut 0.1.0');
  });
});

describe("a project whose own policy keeps a person's gate on (ISS-1058)", () => {
  it('keeps the cut the owner’s on a strict project', async () => {
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    await fx.insertIssue('awaiting_release', NOTE);
    expect(await draft()).toMatchObject({ waitingOn: { kind: 'you', act: 'cut 0.1.0' } });
    expect((await activityRow()).people.total).toBe(1);
  });

  it('keeps a release approval the person’s where the project requires one, and the cut still the master’s', async () => {
    await db.execute(sql`
      UPDATE project_config_documents
         SET document = jsonb_set(document, '{release}',
                                  coalesce(document->'release', '{}'::jsonb) || '{"approval":{"required":true}}'::jsonb)
       WHERE project_id = ${projectId}`);
    const { readOwedPolicy } = await import('../../src/project-config/index.js');
    expect((await readOwedPolicy(projectId)).releaseApproval).toBe(true);
    const { agentTakesOf } = await import('../../src/development/needs-you-agent-takes.js');
    const takes = await agentTakesOf(projectId);
    const answer = (act: string) => ({
      id: act,
      label: act,
      act,
      path: '/api/x',
      body: null,
      needsReason: false,
      declines: false,
      effect: null,
      recommended: false,
    });
    const decide = { answers: [answer('release.decide')], topic: 'release', opens: null } as never;
    const cut = { answers: [answer('release.cut')], topic: 'release', opens: null } as never;
    expect(takes(decide), 'the master took an approval the project keeps for a person').toBe(false);
    expect(takes(cut)).toBe(true);
  });
});

describe('a resolved report filed under a person’s account by an automated check (ISS-1058)', () => {
  it('owes its confirm to the master, never to the reporter’s you', async () => {
    const [fb] = await rows<{ id: string }>(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, reported_by, reporter_agency, status,
                            route, answer, where_seen)
      VALUES (${projectId}, 145, 'bug', 'release check: health endpoint slow', ${ownerId}, 'human',
              'triaged', 'answer', 'It reads within budget on the running build.', 'release check')
      RETURNING id`);
    const item = (await call('owner', 'GET', `/api/projects/${projectId}/feedback/FB-145`)) as Doc;
    const standing = (item.feedback ?? item) as Doc;
    expect(standing.waitingOn).toMatchObject({ kind: 'agent', act: 'Confirm the answer' });
    const read = await needsYou();
    expect((read.decisions as Doc[]).filter((d) => d.entity === 'feedback')).toEqual([]);
    expect((await activityRow()).people.total).toBe(0);
    const swept = await sweep();
    expect(swept.work.owedLine).toContain('FB-145');
    expect(fb?.id).toBeTruthy();
  });
});
