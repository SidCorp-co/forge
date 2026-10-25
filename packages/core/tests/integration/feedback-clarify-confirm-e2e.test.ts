/**
 * REQ-66 BC-4 and BC-8 (ISS-695): the agent asks a reporter one question at a time, with the answer it
 * recommends; and when the fix ships, a reporter that is an agent is asked to confirm it as a person
 * is, through its own read of the item, and confirms or reopens it with its evidence.
 *
 * Planted from forge-dev on 2026-10-25: FB-169, FB-175, FB-230, FB-264, FB-276 and FB-277, each filed
 * by an agent (forge, catalog-fe, catalog-api, forge-plugin) and routed to an issue that closed, read
 * "resolved: no notice sent; a holder of feedback.approve tells the reporter" for ever. An agent has no
 * bell, the release skipped it, and nothing asked it or let it answer.
 *
 * The agent's own project's master is owed that confirm: its owed line names the item and its door, and
 * the release that ships the item wakes it, as a merge owed does (REQ-71 BC-4).
 *
 * @direct-test-of packages/core/src/feedback/attachments.ts
 * @direct-test-of packages/core/src/feedback/forge-settle.ts
 * @direct-test-of packages/core/src/feedback/owed-verify.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';
import { ago, feedback, issue, type World, world } from '../helpers/forecast-world.js';

let w: World;
let member = '';
let memberToken = '';
let agent = '';
let agentPat = '';
/** The agent's own project, whose master box reads what it is owed. */
const own = { projectId: '', runnerId: '', deviceId: '', box: '' };

const at = (path: string) => `/api/projects/${w.projectId}${path}`;
const refusalOf = (body: Body) =>
  ((body.error as { refusals?: { code: string; path: string; detail: string }[] })?.refusals ??
    [])[0];

async function detail(key: string, token = w.token): Promise<Body> {
  const res = await api(token, 'GET', at(`/feedback/${key}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.feedback as Body;
}

/** An untriaged item `reporter` filed. */
async function filed(reporter: string): Promise<string> {
  const key = await feedback(w);
  await db.execute(sql`
    UPDATE feedback SET reported_by = ${reporter} WHERE project_id = ${w.projectId} AND fb_seq = ${Number(key.slice(3))}
  `);
  return key;
}

const ask = (key: string, body: Record<string, unknown>) =>
  api(w.token, 'POST', at(`/feedback/${key}/clarification`), body);

beforeAll(async () => {
  w = await world();
  member = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, member, 'member');
  memberToken = await userToken(member);
  agent = (await createTestUser({ kind: 'agent' })).id;
  await db.execute(sql`UPDATE users SET display_name = 'catalog-fe' WHERE id = ${agent}`);
  // the agent works in a project of its own and reports about Forge into the home project, of which
  // it is no member (REQ-47 BC-3)
  const client = (await createTestProject(w.userId)).id;
  await addProjectMember(client, agent);
  own.projectId = client;
  own.deviceId = await createTestDevice(w.userId);
  own.runnerId = await bindTestRunner(client, own.deviceId);
  own.box = (
    await mintPat({
      permissions: ['*'],
      userId: w.userId,
      name: 'master box',
      deviceId: own.deviceId,
      projectIds: [client],
    })
  ).plaintext;
  agentPat = (
    await mintPat({
      permissions: ['*'],
      userId: agent,
      name: 'box',
      projectIds: [client],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;
  await db.execute(sql`
    INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${w.projectId})
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${w.projectId}
  `);
}, 120_000);

describe('a clarification carries the answer recommended, one at a time to each reporter (BC-4)', () => {
  it('refuses one with no recommended answer, naming the field', async () => {
    const fb = await filed(member);
    const res = await ask(fb, { prompt: 'Which browser shows it?', needed: 'The browser' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/recommended/);
    expect((await detail(fb)).clarification).toBeNull();
  });

  it('asks with it, and the item and the question both read the recommendation', async () => {
    const fb = await filed(member);
    const res = await ask(fb, {
      prompt: 'Which browser shows it?',
      needed: 'The browser and its version',
      recommended: 'Chrome 130 on macOS',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.feedback as Body).clarification).toMatchObject({
      status: 'open',
      prompt: 'Which browser shows it?',
      recommended: 'Chrome 130 on macOS',
    });
    const [q] = (await db.execute(sql`
      SELECT steps -> -1 ->> 'recommended' AS recommended FROM agent_questions
       WHERE feedback_id = (SELECT id FROM feedback WHERE project_id = ${w.projectId} AND fb_seq = ${Number(fb.slice(3))})
    `)) as unknown as { recommended: string | null }[];
    expect(q?.recommended, 'the reporter sends it by one click: it is the round’s own').toBe(
      'Chrome 130 on macOS',
    );
  });

  it('refuses a second question to the same reporter while one is open on another of their items', async () => {
    const reporter = (await createTestUser({ verified: true })).id;
    await addProjectMember(w.projectId, reporter, 'member');
    const first = await filed(reporter);
    const second = await filed(reporter);
    const asked = await ask(first, {
      prompt: 'Which page were you on?',
      needed: 'The page',
      recommended: 'The board',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const open = (asked.body.feedback as Body).clarification as Body;
    const again = await ask(second, {
      prompt: 'Which card was it?',
      needed: 'The card',
      recommended: 'The first card',
    });
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(400);
    const refusal = refusalOf(again.body);
    expect(refusal?.code).toBe('FEEDBACK_CLARIFICATION_ALREADY_OPEN');
    expect(refusal?.detail).toContain(String(open.id));
    expect(refusal?.detail).toContain(first);
    expect((await detail(second)).clarification).toBeNull();

    // another reporter is asked at once
    const theirs = await filed(w.userId);
    const other = await ask(theirs, {
      prompt: 'Which card was it?',
      needed: 'The card',
      recommended: 'The first card',
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);

    // answered, the reporter may be asked again
    expect(
      (
        await api(await userToken(reporter), 'POST', `/api/questions/${String(open.id)}/answer`, {
          round: 1,
          text: 'The board',
        })
      ).status,
    ).toBe(200);
    const after = await ask(second, {
      prompt: 'Which card was it?',
      needed: 'The card',
      recommended: 'The first card',
    });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
  });
});

/** An item `agent` filed about Forge from its own project, routed to an issue that closed. */
async function shippedFromOwnProject(): Promise<{ key: string; id: string; carrier: string }> {
  const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
  const key = await feedback(w, [carrier.id]);
  const [row] = (await db.execute(sql`
    UPDATE feedback SET reported_by = ${agent}, reporter_agency = 'agent'
     WHERE project_id = ${w.projectId} AND fb_seq = ${Number(key.slice(3))}
    RETURNING id
  `)) as unknown as { id: string }[];
  const id = String(row?.id);
  await db.execute(sql`
    INSERT INTO feedback_occurrences (feedback_id, reported_by, reporter_agency, source_project_id)
    VALUES (${id}, ${agent}, 'agent', ${own.projectId})
  `);
  return { key, id, carrier: carrier.id };
}

/** What core tells a project's master box it is owed besides issues, as its pass reads it. */
async function owedLineOf(box: string, projectId: string, runnerId: string): Promise<string> {
  const res = await api(box, 'POST', '/api/devices/me/master-session/verdict', {
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
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { work: { owedLine: string } }).work.owedLine;
}

/** The feedback keys a master's owed line names as owing a confirm. */
const confirmsOwed = (line: string) =>
  (/owes? (?:its|their) confirm \(([^)]*)\)/.exec(line)?.[1] ?? '')
    .split('; ')
    .map((k) => k.split(' ')[0])
    .filter(Boolean);

describe('the master of the agent reporter’s own project is owed its confirm', () => {
  it('names the shipped item on that master’s owed line, with the door it confirms through, until it is settled', async () => {
    const fb = await shippedFromOwnProject();
    const line = await owedLineOf(own.box, own.projectId, own.runnerId);
    expect(confirmsOwed(line), line).toContain(fb.key);
    expect(line).toContain(`forge-runner api forge/feedback/${fb.key}/verify -X POST`);
    expect(line).toContain('catalog-fe');

    const done = await api(agentPat, 'POST', `/api/forge/feedback/${fb.key}/verify`, {
      evidence: 'Ran forge claim --next on 0.4.0-dev.309: the lease was taken, exit 0.',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(confirmsOwed(await owedLineOf(own.box, own.projectId, own.runnerId))).not.toContain(
      fb.key,
    );
  });

  it('wakes that master when the release ships the item, which no bell reaches', async () => {
    const fb = await shippedFromOwnProject();
    const { roomManager } = await import('../../src/lib/rooms.js');
    const publish = vi.spyOn(roomManager, 'publish');
    try {
      const { consumerOf } = await import('../../src/outbox/consumers.js');
      if (!consumerOf('release.shipped', 'master-wake')) {
        const { registerMasterWakeSubscribers } = await import('../../src/ws/master-wake.js');
        registerMasterWakeSubscribers();
      }
      const wake = consumerOf('release.shipped', 'master-wake');
      expect(wake, 'the master wake consumes the release that ships an item').toBeDefined();
      await wake?.handle(
        {
          projectId: w.projectId,
          runId: randomUUID(),
          version: '0.4.0-dev.309',
          issueIds: [fb.carrier],
        },
        { eventId: randomUUID() } as never,
      );
      const wakes = publish.mock.calls
        .map((c) => ({ room: c[0] as string, ...(c[1] as { event: string; data: Body }) }))
        .filter((e) => e.event === 'master.wake');
      expect(wakes).toContainEqual({
        room: `device:${own.deviceId}`,
        event: 'master.wake',
        data: expect.objectContaining({
          projectId: own.projectId,
          source: 'feedback',
          feedbackId: fb.id,
          owes: 'confirm',
        }),
      });
    } finally {
      publish.mockRestore();
    }
  });
});

describe('an agent reporter is asked to confirm a shipped fix, and answers with evidence (BC-8)', () => {
  /** An item `agent` filed about Forge, routed to an issue that closed: its work shipped. */
  async function shippedAgentItem(): Promise<string> {
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    const key = await feedback(w, [carrier.id]);
    await db.execute(sql`
      UPDATE feedback SET reported_by = ${agent}, reporter_agency = 'agent'
       WHERE project_id = ${w.projectId} AND fb_seq = ${Number(key.slice(3))}
    `);
    return key;
  }

  const forgeDoor = (key: string, verb: 'verify' | 'reopen', body: Record<string, unknown>) =>
    api(agentPat, 'POST', `/api/forge/feedback/${key}/${verb}`, body);

  it('waits on the agent, never on a person relaying to it, and its own read asks it', async () => {
    const fb = await shippedAgentItem();
    const d = await detail(fb);
    expect(d.phase).toBe('resolved');
    expect(d.shipNotice).toMatchObject({ state: 'told', how: 'asked' });
    expect(
      d.reporterNotTold,
      'no relay is owed to a reporter that reads the item itself',
    ).toBeNull();
    expect((d.can as Body).tellShipped).toBe(false);
    expect(d.waitingOn).toMatchObject({ kind: 'agent', who: 'catalog-fe', act: 'verify the fix' });
    expect(String((d.waitingOn as Body).rule)).toContain('the reporter checks the fix');
    expect(d.attentionGroup, 'no person’s Needs you').not.toBe('needs_you');

    const own = await api(agentPat, 'GET', `/api/forge/feedback/${fb}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ key: fb, phase: 'resolved' });
    expect(JSON.stringify(own.body.progress)).toContain('catalog-fe');
    expect(own.body.shipEvidence).toMatchObject({
      criterion: null,
      reads: 'This item names no criterion, so there is no check to show.',
      says: { reads: { key: 'feedback.evidence.noCriterion' } },
    });
  });

  it('refuses a bare confirm by name, and another account’s, then confirms with the evidence', async () => {
    const fb = await shippedAgentItem();
    const bare = await forgeDoor(fb, 'verify', {});
    expect(bare.status, JSON.stringify(bare.body)).toBeGreaterThanOrEqual(400);
    expect(refusalOf(bare.body)).toMatchObject({
      code: 'FEEDBACK_EVIDENCE_REQUIRED',
      path: '/evidence',
    });
    expect((await detail(fb)).phase).toBe('resolved');

    const theirs = await api(memberToken, 'POST', `/api/forge/feedback/${fb}/verify`, {
      evidence: 'Ran it myself.',
    });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(403);
    expect(refusalOf(theirs.body)?.code).toBe('FORGE_FEEDBACK_NOT_YOURS');

    const evidence = 'Ran forge claim --next on 0.4.0-dev.309: the lease was taken, exit 0.';
    const done = await forgeDoor(fb, 'verify', { evidence });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ key: fb, phase: 'verified' });
    const d = await detail(fb);
    expect(d.verified).toMatchObject({ how: 'person', by: agent, byReporter: true });
    expect(String((d.verified as Body).reason)).toContain(evidence);
  });

  it('reopens with what it saw, and the item goes back to triage', async () => {
    const fb = await shippedAgentItem();
    const bare = await forgeDoor(fb, 'reopen', {});
    expect(refusalOf(bare.body)).toMatchObject({ path: '/evidence' });
    const reopened = await forgeDoor(fb, 'reopen', {
      evidence: 'On 0.4.0-dev.309 forge claim --next still refuses the free lease: exit 3.',
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ phase: 'reopened' });
  });

  // last in the file: it moves the home project's policy for good
  it('withholds the evidence from the agent where the home project keeps its data from every provider', async () => {
    const fb = await shippedAgentItem();
    const { seedProjectDocument } = await import('../helpers/release-world.js');
    await seedProjectDocument(w.projectId, w.userId, {
      environments: {},
      extra: { sensitiveData: 'no_egress' },
    });
    const own = await api(agentPat, 'GET', `/api/forge/feedback/${fb}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.shipEvidence).toBeNull();
  });
});
