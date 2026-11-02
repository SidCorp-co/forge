/**
 * REQ-66 BC-8 (ISS-880): an agent reporter has no bell, so the master of the project it reported from
 * is asked to confirm its shipped feedback, and the door that settles the item admits that master as
 * it admits the reporter. Who counts is one rule: an agent's credential that writes the project the
 * item was reported from, read by the same rule the owed line lists it by.
 *
 * Planted from FB-477 (adminhub-api) and FB-478 (agenfold), 2026-11-02: FB-473 was filed about Forge by
 * adminhub-api's channel agent and shipped; adminhub-api's master pane, acting as the project's own
 * agent, was named the item on every pass and answered FORGE_FEEDBACK_NOT_FOUND on its read and
 * FORGE_FEEDBACK_NOT_YOURS on its verify, so nobody could settle it. agenfold's FB-470 and FB-476 the
 * same.
 *
 * @direct-test-of packages/core/src/feedback/reporter-master.ts
 * @direct-test-of packages/core/src/feedback/forge-settle.ts
 * @direct-test-of packages/core/src/feedback/owed-verify.ts
 * @direct-test-of packages/core/src/forge-door/service.ts
 * @direct-test-of packages/core/src/masters/owed-confirms.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { ago, feedback, issue, type World, world } from '../helpers/forecast-world.js';

/** The Forge home project, and the reporter's own project with its master box. */
let home: World;
let own: World;
/** The channel agent (Rocket.Chat) of the reporter's project, which files the item. */
let channel = '';
const tokens = { channel: '', master: '', box: '', stranger: '', person: '' };

interface Refused {
  code: string;
  path: string;
  detail: string;
}
const refusalOf = (body: Body): Refused | undefined =>
  ((body.error as { refusals?: Refused[] })?.refusals ?? [])[0];

const pat = async (userId: string, projectId: string, deviceId?: string) =>
  (
    await mintPat({
      permissions: ['*'],
      userId,
      name: deviceId ? 'checkout' : 'box',
      projectIds: [projectId],
      ...(deviceId ? { deviceId } : {}),
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;

beforeAll(async () => {
  home = await world();
  own = await world();
  // the channel agent (Rocket.Chat) and the project's own agent, which the master pane acts as, are
  // both agents of the reporter's project and no members of the home project (REQ-47 BC-3)
  channel = (await createTestUser({ kind: 'agent' })).id;
  await db.execute(sql`UPDATE users SET display_name = 'adminhub-chat' WHERE id = ${channel}`);
  const master = (await createTestUser({ kind: 'agent' })).id;
  for (const id of [channel, master]) await addProjectMember(own.projectId, id);
  tokens.channel = await pat(channel, own.projectId);
  // the checkout credential the master pane borrows: the project's agent, on the box, fenced to it
  tokens.master = await pat(master, own.projectId, own.deviceId);
  tokens.box = (
    await mintPat({
      permissions: ['*'],
      userId: own.userId,
      name: 'master box',
      deviceId: own.deviceId,
      projectIds: [own.projectId],
    })
  ).plaintext;
  // an agent of another project, and a person of the reporter's own project
  const elsewhere = (await createTestProject(home.userId)).id;
  const stranger = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(elsewhere, stranger);
  tokens.stranger = await pat(stranger, elsewhere);
  const person = (await createTestUser({ verified: true })).id;
  await addProjectMember(own.projectId, person);
  tokens.person = await userToken(person);
  await db.execute(sql`
    INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${home.projectId})
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${home.projectId}
  `);
}, 120_000);

/** FB-473: an item about Forge the channel agent filed from its own project, routed to an issue that closed. */
async function shippedForgeItem(): Promise<string> {
  const carrier = await issue(home, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
  const key = await feedback(home, [carrier.id]);
  const [row] = (await db.execute(sql`
    UPDATE feedback SET reported_by = ${channel}, reporter_agency = 'agent'
     WHERE project_id = ${home.projectId} AND fb_seq = ${Number(key.slice(3))}
    RETURNING id
  `)) as unknown as { id: string }[];
  await db.execute(sql`
    INSERT INTO feedback_occurrences (feedback_id, reported_by, reporter_agency, source_project_id)
    VALUES (${String(row?.id)}, ${channel}, 'agent', ${own.projectId})
  `);
  return key;
}

/** The project-door twin: an item the channel agent filed in its own project, shipped. */
async function shippedOwnItem(): Promise<string> {
  const carrier = await issue(own, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
  const key = await feedback(own, [carrier.id]);
  await db.execute(sql`
    UPDATE feedback SET reported_by = ${channel}, reporter_agency = 'agent'
     WHERE project_id = ${own.projectId} AND fb_seq = ${Number(key.slice(3))}
  `);
  return key;
}

const forgeDoor = (token: string, key: string, verb?: 'verify' | 'reopen', evidence?: string) =>
  verb
    ? api(token, 'POST', `/api/forge/feedback/${key}/${verb}`, evidence ? { evidence } : {})
    : api(token, 'GET', `/api/forge/feedback/${key}`);

async function homeDetail(key: string): Promise<Body> {
  const res = await api(home.token, 'GET', `/api/projects/${home.projectId}/feedback/${key}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.feedback as Body;
}

/** What core tells the reporter's project's master box it is owed besides issues, as its pass reads it. */
async function owedLine(): Promise<string> {
  const res = await api(tokens.box, 'POST', '/api/devices/me/master-session/verdict', {
    projectId: own.projectId,
    runnerId: own.runnerId,
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
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { work: { owedLine: string } }).work.owedLine;
}

const owedKeys = (line: string) =>
  (/owes? (?:its|their) confirm \(([^)]*)\)/.exec(line)?.[1] ?? '')
    .split('; ')
    .map((k) => k.split(' ')[0])
    .filter(Boolean);

describe('the master of the reporting agent’s project settles its shipped Forge feedback (FB-473)', () => {
  it('lists the item, reads it, verifies it with evidence on the reporter’s behalf, and stops listing it', async () => {
    const key = await shippedForgeItem();
    const line = await owedLine();
    expect(owedKeys(line), line).toContain(key);
    expect(line).toContain(`forge-runner api forge/feedback/${key}/verify -X POST`);

    const read = await forgeDoor(tokens.master, key);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ key, phase: 'resolved' });

    const bare = await forgeDoor(tokens.master, key, 'verify');
    expect(bare.status, JSON.stringify(bare.body)).toBe(422);
    expect(refusalOf(bare.body)?.code).toBe('FEEDBACK_EVIDENCE_REQUIRED');

    const done = await forgeDoor(
      tokens.master,
      key,
      'verify',
      'Ran GET /api/version on adminhub-api: the shipped build answers, exit 0.',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ key, phase: 'verified' });
    const decided = (await homeDetail(key)).decisions as { decision: string; reason: string }[];
    expect(decided.at(-1)).toMatchObject({ decision: 'verified' });
    expect(decided.at(-1)?.reason).toContain('on behalf of the reporter');

    expect(owedKeys(await owedLine())).not.toContain(key);
  });

  it('reopens one that is not fixed, with what it saw', async () => {
    const key = await shippedForgeItem();
    const res = await forgeDoor(
      tokens.master,
      key,
      'reopen',
      'Ran the channel reply on the shipped build: the same 500 comes back.',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(owedKeys(await owedLine())).not.toContain(key);
  });

  it('still refuses an agent of another project and a person who did not report it, writing nothing', async () => {
    const key = await shippedForgeItem();
    const evidence = 'Ran it and it works.';
    for (const token of [tokens.stranger, tokens.person]) {
      const read = await forgeDoor(token, key);
      expect(read.status, JSON.stringify(read.body)).toBe(404);
      expect(refusalOf(read.body)?.code).toBe('FORGE_FEEDBACK_NOT_FOUND');
      const verify = await forgeDoor(token, key, 'verify', evidence);
      expect(verify.status, JSON.stringify(verify.body)).toBe(404);
      expect(refusalOf(verify.body)?.code).toBe('FORGE_FEEDBACK_NOT_FOUND');
    }
    // a person of the home project reads it, and is still not the one it waits on
    const member = await forgeDoor(home.token, key, 'verify', evidence);
    expect(member.status, JSON.stringify(member.body)).toBe(403);
    expect(refusalOf(member.body)?.code).toBe('FORGE_FEEDBACK_NOT_YOURS');
    expect((await homeDetail(key)).phase).toBe('resolved');
    expect(owedKeys(await owedLine())).toContain(key);
  });
});

describe('the project-door twin admits the same master', () => {
  it('lists an item of the project’s own, and its master verifies it with a note', async () => {
    const key = await shippedOwnItem();
    const line = await owedLine();
    expect(owedKeys(line), line).toContain(key);
    expect(line).toContain(`forge-runner api projects/${own.projectId}/feedback/${key}/verify -X POST`);
    const res = await api(
      tokens.master,
      'POST',
      `/api/projects/${own.projectId}/feedback/${key}/verify`,
      { note: 'Ran the channel reply on the shipped build: it answers in the thread.' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // keys repeat across projects (the home project has its own FB-1): the door names which
    expect(await owedLine()).not.toContain(`projects/${own.projectId}/feedback/${key}/verify`);
  });
});
