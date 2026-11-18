import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { createTestIssue, createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import type { TurnMessage } from '../helpers/support-session-box.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/fixes.ts
 * @direct-test-of packages/core/src/support/record.ts
 * @direct-test-of packages/core/src/support/record-pictures.ts
 * @direct-test-of packages/core/src/support/store.ts
 * @direct-test-of packages/core/src/feedback/attachments.ts
 * @direct-test-of packages/core/src/feedback/external.ts
 * @direct-test-of packages/core/src/support/read.ts
 * @direct-test-of packages/core/src/support/result.ts
 * @direct-test-of packages/core/src/support/routing-signals.ts
 * @direct-test-of packages/core/src/support/prompt.ts
 */

// ISS-1088, from FB-554: in adminhub-api's channel a record made for adminhub-fe was agreed to and
// answered a raw "project <adminhub-api> holds no feedback 8866d9ce…". The item was filed in fe;
// the thread's pictures were then attached under the channel's own project, which holds no such
// item, and the claim had already consumed the proposal, so a retry answered
// SUPPORT_PROPOSAL_UNKNOWN and the agent could not say whether anything was filed.

const w = new SupportWorld();
let chat: StandInRocketChat;
const tag = randomUUID().slice(0, 6);
const API = `adminhub-api-${tag}`;
const FE = `adminhub-fe-${tag}`;
const DOCS = `adminhub-docs-${tag}`;
let feId = '';
/** The followed project's record the first case files, read again by the third (ISS-1243). */
let feRecord = { key: '', thread: '' };

// a 1x1 PNG: a feedback attachment's bytes are sniffed, so it must be one
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const agentBlock = (projects: string[]) => ({
  product: 'AdminHub, the back office',
  readers: 'users',
  grants: { abilities: ['file_items'] },
  projects,
});

/** Write the binding's `agent` block through the binding door. */
async function writeAgent(agent: Record<string, unknown>) {
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${w.rcConnectionId}::uuid`,
  );
  const path = `/api/projects/${w.projectId}/bindings/${String(b?.id)}`;
  const got = await api(w.owner, 'GET', path);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const document = got.body.document as { target: Record<string, unknown> };
  const put = await api(w.owner, 'PUT', path, {
    baseRevision: got.body.revision,
    document: { ...document, target: { ...document.target, agent } },
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

/** The state a proposal stands in, by the handle the session was given. */
async function proposalState(code: string): Promise<string | undefined> {
  const [row] = await rows<{ state: string }>(
    sql`SELECT state FROM support_proposals WHERE code = ${code}`,
  );
  return row?.state;
}

/** A member's message with one picture, and the record the session proposes for it to `project`. */
async function proposeFrom(
  text: string,
  title: string,
  project: string,
): Promise<{ thread: string; proposal: string }> {
  await w.settleWarm();
  let proposal = '';
  let thread = '';
  w.box.model = async (turn, act) => {
    const m = turn.messages.find((x) => x.from !== 'forge' && x.text.includes(text));
    if (!m || proposal) return;
    thread = m.thread;
    const out = await act({
      action: 'record',
      thread: m.thread,
      kind: 'feature',
      title,
      summary: `${title}, asked in the users' group.`,
      project,
      // the message's picture, named as evidence (ISS-1327)
      pictures: [{ message: m.message }],
    });
    proposal = String(out.proposal ?? JSON.stringify(out));
  };
  await chat.sayWithImages(chat.alice, text, [
    { name: 'orders.png', mime: 'image/png', bytes: PNG_BYTES },
  ]);
  await expect.poll(() => proposal, { timeout: 15_000 }).not.toBe('');
  expect(proposal).toMatch(/^[A-Za-z0-9-]+$/);
  return { thread, proposal };
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const orgId = String(home?.org_id);
  await db.execute(sql`UPDATE projects SET slug = ${API} WHERE id = ${w.projectId}::uuid`);
  feId = (await createTestProject(w.ownerId, { orgId })).id;
  await db.execute(sql`UPDATE projects SET slug = ${FE} WHERE id = ${feId}::uuid`);
  const docsId = (await createTestProject(w.ownerId, { orgId })).id;
  await db.execute(sql`UPDATE projects SET slug = ${DOCS} WHERE id = ${docsId}::uuid`);
  await w.bindTarget({ rids: [chat.rid], agent: agentBlock([FE]) });
}, 120_000);

afterAll(() => w.stop());

describe('ISS-1088: agree resolves a record in the project it was made for', () => {
  it("files a followed project's record there, its pictures with it, and names the key and the project", async () => {
    const title = `Export the order list as CSV ${tag}`;
    const { thread, proposal } = await proposeFrom(
      `Can the order list export CSV ${tag}?`,
      title,
      FE,
    );
    const { out } = await w.agreeBy(chat.alice, `yes record it ${tag}`, thread, proposal);
    expect(refusalCodes(out), JSON.stringify(out)).toEqual([]);
    expect(out).toMatchObject({
      recorded: true,
      created: true,
      project: FE,
      feedbackKey: expect.stringMatching(/^FB-\d+$/),
      pictures: { attached: 1, notAttached: [] },
    });
    expect(String(out.what)).toContain(`${String(out.feedbackKey)} in ${FE}`);
    const filed = await rows<{ project_id: string; attachments: number }>(
      sql`SELECT f.project_id, (SELECT count(*)::int FROM feedback_attachments a
                                 WHERE a.feedback_id = f.id AND a.project_id = f.project_id) AS attachments
            FROM feedback f WHERE f.title = ${title}`,
    );
    expect(filed).toEqual([{ project_id: feId, attachments: 1 }]);
    expect(await proposalState(proposal)).toBe('ran');
    feRecord = { key: String(out.feedbackKey), thread };
  });

  it("names a followed project's record by its key and project on the room's action and its result (ISS-1243)", async () => {
    expect(feRecord.key).toMatch(/^FB-\d+$/);
    const roomId = String((await w.rooms())[0]?.id);
    const recorded = (await w.actions(roomId)).filter((a) => a.kind === 'feedback_recorded');
    // read within the room's project alone, every cross-project record came back keyless
    expect(recorded.map((a) => [a.feedbackKey, a.feedbackProject])).toEqual([[feRecord.key, FE]]);
    const triage = `/api/projects/${feId}/feedback/${feRecord.key}/triage`;
    const declined = await api(w.owner, 'POST', triage, {
      route: 'decline',
      note: 'CSV export is not planned.',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBeLessThan(300);
    const { tellAllResults } = await import('../../src/support/index.js');
    await tellAllResults();
    const [told] = await rows<{ output: Record<string, unknown> }>(sql`
      SELECT a.output FROM support_actions a JOIN feedback f ON f.id = a.feedback_id
       WHERE f.project_id = ${feId}::uuid AND a.kind = 'result_told'`);
    expect(told?.output).toMatchObject({
      phase: 'declined',
      feedbackKey: feRecord.key,
      project: FE,
    });
    const [note] = await rows<{ input: { note?: string } }>(sql`
      SELECT a.input FROM support_actions a JOIN feedback f ON f.id = a.feedback_id
       WHERE f.project_id = ${feId}::uuid AND a.kind = 'message_in'`);
    expect(String(note?.input.note)).toContain(
      `${feRecord.key} of ${FE}, recorded from this thread`,
    );
    await w.settleWarm();
  });

  // ISS-1243 item 11: agent.projects is a hint, not a fence: a project of the organization the
  // binding stops naming between the proposal and the agreement still takes the filing
  it('files a proposal in the project it names after the binding stops naming it', async () => {
    const title = `Bulk mark orders valid ${tag}`;
    const { thread, proposal } = await proposeFrom(
      `Can I mark many orders valid ${tag}?`,
      title,
      FE,
    );
    await writeAgent(agentBlock([DOCS]));
    const agreed = await w.agreeBy(chat.alice, `ok go ahead ${tag}`, thread, proposal);
    expect(refusalCodes(agreed.out), JSON.stringify(agreed.out)).toEqual([]);
    expect(agreed.out).toMatchObject({ recorded: true, project: FE });
    expect(await proposalState(proposal)).toBe('ran');
    const filed = await rows<{ project_id: string }>(
      sql`SELECT project_id FROM feedback WHERE title = ${title}`,
    );
    expect(filed).toEqual([{ project_id: feId }]);
    await writeAgent(agentBlock([FE]));
  });
  it("hands each message the routing signals core holds: its sender, their history, its thread's records and the room's projects (ISS-1243)", async () => {
    await w.settleWarm();
    // alice's chat account is linked to the owner, who reported an issue in fe
    const namespace = new URL(chat.serverUrl).host;
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${chat.alice.userId}, ${w.ownerId}, 'channel_email_match')`);
    await db.execute(
      sql`UPDATE users SET display_name = ${`Owner ${tag}`} WHERE id = ${w.ownerId}::uuid`,
    );
    const reported = await createTestIssue(feId, w.ownerId, 9_001, {
      status: 'open',
      createdAt: new Date(),
    });
    const filed = await rows<{ fb_seq: number }>(
      sql`SELECT fb_seq FROM feedback WHERE project_id = ${feId}::uuid ORDER BY created_at DESC`,
    );
    expect(filed).toHaveLength(2);
    const heard: TurnMessage[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        heard.push(m);
        await act({
          action: 'decide',
          thread: m.thread,
          message: m.message,
          decision: 'silent',
          signals: ['sender_history'],
          confidence: 'high',
          why: 'recorded for the test',
        });
      }
    };
    const fresh = await chat.say(chat.alice, `Is the CSV export coming ${tag}?`);
    await expect.poll(() => heard.length, { timeout: 15_000 }).toBe(1);
    // [ROUTING_UNSIGNALLED] before the fix: the head carried the words and roles alone
    expect(heard[0]?.routing).toEqual({
      // every project of the organization the room reaches, its home first (item 11)
      roomProjects: [API, FE, DOCS],
      sender: {
        linked: true,
        account: `Owner ${tag}`,
        pastProjects: [`${FE} ×2`],
        filedFor: filed.map((f) => `${FE} FB-${f.fb_seq}`),
        reported: [`${FE} ${reported.key}`],
      },
      thread: { records: [], decidedProject: null },
    });
    expect(heard[0]?.thread).toBe(fresh);
    await w.settleWarm();
    await chat.say(chat.alice, `any news on it ${tag}?`, feRecord.thread);
    await expect.poll(() => heard.length, { timeout: 15_000 }).toBe(2);
    expect(heard[1]?.routing?.thread).toEqual({
      records: [feRecord.key.replace('FB-', `${FE} FB-`)],
      decidedProject: null,
    });
    await w.settleWarm();
  });
});
