import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/fixes.ts
 * @direct-test-of packages/core/src/support/record.ts
 * @direct-test-of packages/core/src/support/store.ts
 * @direct-test-of packages/core/src/feedback/attachments.ts
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
  });

  it('leaves a proposal standing when agree cannot file it, refuses by name, and files it on the next agree', async () => {
    const title = `Bulk mark orders valid ${tag}`;
    const { thread, proposal } = await proposeFrom(
      `Can I mark many orders valid ${tag}?`,
      title,
      FE,
    );
    // fe leaves the set between the proposal and the agreement
    await writeAgent(agentBlock([DOCS]));
    const first = await w.agreeBy(chat.alice, `ok go ahead ${tag}`, thread, proposal);
    expect(refusalCodes(first.out), JSON.stringify(first.out)).toEqual([
      'SUPPORT_RECORD_NOT_FILED',
    ]);
    const said = JSON.stringify(first.out);
    expect(said).toContain('OPS_OUT_OF_SCOPE');
    expect(said).toContain(`${proposal} still stands`);
    expect(said).not.toContain('holds no feedback');
    expect(await proposalState(proposal)).toBe('pending');
    expect(await rows(sql`SELECT 1 FROM feedback WHERE title = ${title}`)).toEqual([]);
    // fe is followed again: the same proposal files on the person's answer, cited again
    await writeAgent(agentBlock([FE]));
    const again = await w.agreeBy(chat.alice, `yes please ${tag}`, thread, proposal);
    expect(refusalCodes(again.out), JSON.stringify(again.out)).toEqual([]);
    expect(again.out).toMatchObject({ recorded: true, project: FE });
    expect(await proposalState(proposal)).toBe('ran');
    const filed = await rows<{ project_id: string }>(
      sql`SELECT project_id FROM feedback WHERE title = ${title}`,
    );
    expect(filed).toEqual([{ project_id: feId }]);
  });
});
