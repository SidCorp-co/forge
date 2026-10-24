/**
 * Feedback is Delivery's to move once it is routed (REQ-68 BC-4, BC-6; REQ-66 BC-3, BC-6). An item
 * carried by a draft issue, or by one parked at needs_info, waits on the project's master, never on
 * a person: no person's Needs you, project status or feedback list counts it. An item planned on a
 * requirement can be re-routed to the agreed requirement that replaces it, and two open items on
 * one issue can be merged. A duplicate read alone follows its original's phase (FB-188 on dev,
 * 2026-10-23: it read planned while FB-187 read resolved).
 *
 * @direct-test-of packages/core/src/feedback/standing-carrier.ts
 * @direct-test-of packages/core/src/feedback/rules.ts
 * @direct-test-of packages/core/src/feedback/triage.ts
 * @direct-test-of packages/core/src/feedback/list-read.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
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
import { agreedRequirement } from '../helpers/loop-close.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'member';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let otherProjectId = '';
let ownerId = '';
let ownerToken = '';
type Issue = { id: string; key: string };

const MASTER = "The project's master";
const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);
const read = async (fb: string): Promise<Doc> => ok(await say('owner', 'GET', item(fb))).feedback;
const triage = (fb: string, body: Doc) => say('owner', 'POST', item(fb, 'triage'), body);

function refused(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return first;
}

async function file(title: string): Promise<string> {
  const made = ok(
    await say('member', 'POST', at('/feedback'), { kind: 'bug', title, screen: 'The board' }),
    201,
  );
  return made.feedback.key as string;
}

async function issue(title: string): Promise<Issue> {
  const made = ok(await say('owner', 'POST', at('/issues'), { title }), 201);
  expect(made.admission?.status).toBe('draft');
  return { id: made.id, key: made.displayId };
}

async function routedTo(fb: string, carrier: Issue): Promise<void> {
  ok(await triage(fb, { answers: TRIAGE_ANSWERS, route: 'issue', issue: carrier.key }));
}

/** An issue parked at needs_info on a person's answer, as a run's park leaves it. */
async function park(issueId: string): Promise<void> {
  const { db } = await import('../../src/db/client.js');
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(
      sql`UPDATE issues SET status = 'needs_info', waiting_kind = 'needs_answer' WHERE id = ${issueId}`,
    ),
  );
}

async function ship(issueId: string): Promise<void> {
  await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${issueId}`);
  await seedIssueStatus(issueId, 'closed');
}

/** Every count a person reads it through: Needs you, the project status, the feedback list. */
async function personCounts(fb: string) {
  const needs = ok(await say('owner', 'GET', at('/needs-you')));
  const status = ok(await say('owner', 'GET', at('/status')));
  const list = ok(await say('member', 'GET', at('/feedback')));
  const row = list.feedback.find((f: Doc) => f.key === fb);
  return {
    needsYou: needs.items.filter((i: Doc) => i.key === fb).length,
    needsYouFeedback: needs.areas.feedback.you as number,
    statusWaits: status.waits.people.filter((w: Doc) => w.key === fb).length,
    listGroup: row.attentionGroup as string,
    listNeedsYou: list.counts.needs_you as number,
  };
}

const NOBODY_PERSON = {
  needsYou: 0,
  needsYouFeedback: 0,
  statusWaits: 0,
  listGroup: expect.not.stringMatching(/^needs_you$/),
  listNeedsYou: 0,
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  otherProjectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, member, 'member');
  ownerToken = await signUserToken(ownerId);
  say = requester(app, { owner: ownerToken, member: await signUserToken(member) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an item carried by a draft issue waits on the master, not a person (FB-74)', () => {
  let fb = '';
  let carrier: Issue;

  beforeAll(async () => {
    fb = await file('A release waits behind onboarding jobs');
    carrier = await issue('Give releases a slot of their own');
    await routedTo(fb, carrier);
  });

  it('names the master as who takes the draft on', async () => {
    const got = await read(fb);
    expect(got.phase).toBe('triaged');
    expect(got.waitingOn).toMatchObject({
      kind: 'agent',
      who: MASTER,
      act: `take on ${carrier.key}`,
      ref: carrier.key,
    });
    // no master serves this project, which is what holds it now: said, never a person's to take
    expect(got.times.stuck).toMatchObject({ code: 'nobody_serves' });
    expect(got.times.stuck.reason).toBe(
      'It waits on the master, and no master serves this project.',
    );
  });

  it('is counted for no person anywhere', async () => {
    expect(await personCounts(fb)).toEqual(NOBODY_PERSON);
  });
});

describe('an item whose carrier is parked at needs_info waits on the master (FB-135)', () => {
  let fb = '';
  let carrier: Issue;

  beforeAll(async () => {
    fb = await file('Wedge reset sends landed issues back to open');
    carrier = await issue('Keep landed issues out of the wedge reset');
    await routedTo(fb, carrier);
    await park(carrier.id);
  });

  it('reads planned and names the master moving the issue on, never a person deciding', async () => {
    const got = await read(fb);
    expect(got.phase).toBe('planned');
    expect(got.waitingOn).toMatchObject({
      kind: 'agent',
      who: MASTER,
      act: `move ${carrier.key} on`,
      ref: carrier.key,
    });
    expect(got.waitingOn.act).not.toMatch(/make a decision/);
  });

  it('is counted for no person anywhere', async () => {
    expect(await personCounts(fb)).toEqual(NOBODY_PERSON);
  });
});

describe('an item planned on a requirement is re-routed to the one that replaces it (REQ-66)', () => {
  let fb = '';
  let old = '';
  let replacing = '';

  beforeAll(async () => {
    fb = await file('A connection is finished inside a project');
    old = ok(
      await say('owner', 'POST', at('/requirements'), {
        title: 'Connect an outside system',
        reason: 'the requirement it was first routed to',
        criteria: [{ body: 'A connection is added from Integrations.' }],
      }),
      201,
    ).key;
    ok(await triage(fb, { answers: TRIAGE_ANSWERS, route: 'new_requirement', requirement: old }));
    replacing = await agreedRequirement(ownerToken, projectId, ownerId);
  });

  it('re-routes it to the agreed requirement, keeping the first routing in its history', async () => {
    expect((await read(fb)).phase).toBe('planned');
    ok(
      await triage(fb, {
        answers: TRIAGE_ANSWERS,
        route: 'new_requirement',
        requirement: replacing,
        note: `${replacing} replaces ${old}`,
      }),
    );
    const got = await read(fb);
    expect(got.route.carriers).toEqual([expect.objectContaining({ key: replacing })]);
    expect(got.phase).toBe('planned');
    expect(
      got.decisions.filter((d: Doc) => d.decision === 'triaged').map((d: Doc) => d.carrier),
    ).toEqual([old, replacing]);
  });

  it('refuses a requirement that is not agreed, naming its status', async () => {
    const draft = ok(
      await say('owner', 'POST', at('/requirements'), {
        title: 'A draft nobody agreed',
        reason: 'not agreed',
        criteria: [{ body: 'It is still a draft.' }],
      }),
      201,
    ).key;
    const r = refused(
      await triage(fb, { answers: TRIAGE_ANSWERS, route: 'new_requirement', requirement: draft }),
    );
    expect(r).toMatchObject({ code: 'FEEDBACK_ROUTE_TARGET_MISMATCH', path: '/requirement' });
    expect(r.detail).toContain(`${draft} is draft`);
  });

  it("refuses another project's requirement by name", async () => {
    const elsewhere = randomUUID();
    await rows(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status)
      VALUES (${elsewhere}, ${otherProjectId}, 1, 'Somewhere else', 'draft')`);
    const r = refused(
      await triage(fb, {
        answers: TRIAGE_ANSWERS,
        route: 'new_requirement',
        requirement: elsewhere,
      }),
    );
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_NOT_IN_PROJECT', path: '/requirement' });
  });
});

describe('two open items on one issue are merged as duplicates (REQ-66 BC-3)', () => {
  let first = '';
  let second = '';
  let elsewhere = '';
  let carrier: Issue;

  beforeAll(async () => {
    first = await file('Design PUT needs a module on a project with none');
    second = await file('Design PUT refuses every write without modules');
    elsewhere = await file('Something else on another issue');
    carrier = await issue('Let a project with no module write a design');
    const other = await issue('Another issue');
    await routedTo(first, carrier);
    await routedTo(second, carrier);
    await routedTo(elsewhere, other);
    await park(carrier.id);
    await seedIssueStatus(other.id, 'open');
  });

  it('marks the second a duplicate of the first, and the first lists it', async () => {
    expect((await read(second)).phase).toBe('planned');
    ok(
      await triage(second, {
        answers: TRIAGE_ANSWERS,
        route: 'duplicate',
        duplicateOf: first,
        note: `Same defect as ${first}, on ${carrier.key}`,
      }),
    );
    const merged = await read(second);
    expect(merged.duplicateOf).toBe(first);
    expect(merged.route.route).toBe('duplicate');
    expect((await read(first)).duplicates).toContain(second);
  });

  it('still refuses a planned item on another issue, by name', async () => {
    const r = refused(
      await triage(elsewhere, { answers: TRIAGE_ANSWERS, route: 'duplicate', duplicateOf: first }),
    );
    expect(r).toMatchObject({ code: 'FEEDBACK_STATUS_INVALID' });
    expect(r.detail).toContain(first);
  });
});

describe('a duplicate read alone follows its original (FB-188)', () => {
  let root = '';
  let dup = '';

  beforeAll(async () => {
    root = await file('Core reads only the first verdict block');
    dup = await file('Only the first verdict block is read');
    const carrier = await issue('Read every verdict block');
    await routedTo(root, carrier);
    ok(
      await triage(dup, {
        answers: TRIAGE_ANSWERS,
        route: 'duplicate',
        duplicateOf: root,
      }),
    );
    await ship(carrier.id);
  });

  it('reads resolved once its original reads resolved', async () => {
    expect((await read(root)).phase).toBe('resolved');
    expect((await read(dup)).phase).toBe('resolved');
  });
});

// K61 on dev.299 (ISS-669): FB-271 merged into FB-153, both on the draft ISS-572, read planned
// while its original read triaged; a duplicate reads its original's own phase and wait
describe('a duplicate of an item held on a draft carrier reads its original (K61)', () => {
  let root = '';
  let dup = '';
  let carrier: Issue;

  beforeAll(async () => {
    root = await file('Secret detector reads prose token: as a credential');
    dup = await file('Verdict refused for the words token: 503');
    carrier = await issue('Read only real credentials as secrets');
    await routedTo(root, carrier);
    await routedTo(dup, carrier);
    ok(
      await triage(dup, {
        answers: TRIAGE_ANSWERS,
        route: 'duplicate',
        duplicateOf: root,
        note: `Same defect as ${root}`,
      }),
    );
  });

  it('reads triaged while its original reads triaged', async () => {
    expect((await read(root)).phase).toBe('triaged');
    expect((await read(dup)).phase).toBe('triaged');
  });

  it("reads its original's wait and group, the master's to take the draft on", async () => {
    const [own, original] = [await read(dup), await read(root)];
    expect(own.waitingOn).toEqual(original.waitingOn);
    expect(own.waitingOn).toMatchObject({ kind: 'agent', act: `take on ${carrier.key}` });
    expect(own.attentionGroup).toBe(original.attentionGroup);
    expect(own.times.stuck).toEqual(original.times.stuck);
  });

  it('is counted for no person anywhere', async () => {
    expect(await personCounts(dup)).toEqual(NOBODY_PERSON);
  });
});
