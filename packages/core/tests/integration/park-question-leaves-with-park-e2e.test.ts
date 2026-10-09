/**
 * REQ-41 BC-11 (QA of 0.4.0-dev.220, ISS-439): a park's question stops waiting on a person in the
 * same write that moves its issue out of the park, by any door. ISS-439 was parked at `needs_info`
 * by the rescue cap with a question minted, moved back on by a person without an answer, and its
 * question went on reading "Decision waiting - Person - Open" on the issue page, the project home
 * and in chat. Seeds that park through the kernel exactly as the old cap wrote it, moves it out by
 * the park return a person presses (to `awaiting_release`, the status it left, and to `open`), and
 * reads the three surfaces: the issue's questions, Needs you's decisions, and `forge_needs_you` from
 * a chat turn's own toolset. A question somebody else asked while the issue stood parked stays theirs.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let token = '';
let chat: import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;
let toolText: typeof import('../../src/assistant/tools/mcp-adapter.js').toolResultText;
let applyStatusTransition: typeof import('../../src/issues/index.js').applyStatusTransition;
let askQuestion: typeof import('../../src/questions/index.js').askQuestion;

const CAP_REASON =
  '4 run sessions ended on this issue without it moving on, so it has stopped rather than open another.';
const CAP_NEEDS =
  'Whether to send it back to the driver as it stands, or what to change first — answering returns the issue to the status it left.';

/** The rescue cap's old park: an agent move into needs_info that mints the park's question. */
async function parkTheOldWay(seq: number, from: 'open' | 'awaiting_release') {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: from,
    createdAt: new Date(Date.now() - 3_600_000),
  });
  await applyStatusTransition(
    { id: issue.id, projectId, status: from, reopenCount: 0 },
    'needs_info',
    { id: ownerId, ownerId },
    {
      reason: 'autonomous_rescue_cap_reached',
      transitionReason: CAP_REASON,
      needs: CAP_NEEDS,
      waitingKind: 'needs_decision',
    },
  );
  return issue;
}

/** The status-menu move a person presses: Move anyway, which sends no `voidQuestions`. */
async function moveOn(issueId: string, toStatus: string, reason: string) {
  const res = await api(token, 'POST', `/api/issues/${issueId}/transition`, { toStatus, reason });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

interface ShownQuestion {
  id: string;
  status: string;
  voidReason: string | null;
}
/** The issue page's decision panel reads this. */
const issueQuestions = async (id: string) => {
  const res = await api(token, 'GET', `/api/questions?issueId=${id}`);
  expect(res.status).toBe(200);
  return res.body.questions as ShownQuestion[];
};
/** The project home's Needs you reads this. */
const homeDecisionKeys = async () => {
  const res = await api(token, 'GET', `/api/projects/${projectId}/needs-you/decisions`);
  expect(res.status).toBe(200);
  return (res.body.decisions as { key: string }[]).map((d) => d.key);
};
/** Chat's "what waits on me" reads this: the tool a chat turn's own toolset carries. */
const chatDecisionKeys = async () => {
  const result = await chat.execute('forge_needs_you', JSON.stringify({ projectId, limit: 50 }));
  expect(result.isError, toolText(result)).toBeFalsy();
  const read = JSON.parse(toolText(result)) as { decisions: { key: string }[] };
  return read.decisions.map((d) => d.key);
};
const openOn = async (id: string) =>
  (
    await rows<{ id: string }>(
      sql`SELECT id FROM agent_questions WHERE issue_id = ${id} AND status = 'open' ORDER BY created_at`,
    )
  ).map((r) => r.id);

let released = { id: '', key: '' };
let reopened = { id: '', key: '' };
let asked = { id: '', key: '' };
let ownQuestion = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ applyStatusTransition } = await import('../../src/issues/index.js'));
  ({ askQuestion } = await import('../../src/questions/index.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  const { CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  ({ toolResultText: toolText } = await import('../../src/assistant/tools/mcp-adapter.js'));
  const authority = await resolveTurnAuthority({ userId: ownerId, projectId, viaTokenId: null });
  if (!authority.ok) throw new Error(authority.refusal.message);
  const credential = await mintTurnCredential({
    authority: authority.authority,
    menu: CHAT_TURN_MENU,
    ttlMs: 10 * 60_000,
  });
  chat = buildProjectToolset(buildChatToolContext({ credential, projectSlug: 'park' }));

  released = await parkTheOldWay(901, 'awaiting_release');
  reopened = await parkTheOldWay(902, 'open');
  asked = await parkTheOldWay(903, 'open');
  ownQuestion = crypto.randomUUID();
  await askQuestion({
    id: ownQuestion,
    projectId,
    issueId: asked.id,
    prompt: 'From the independent judge: is Half half of the large width?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the width rule', recommended: 'Half of the page.' },
  });
}, 120_000);

afterAll(closeWorld);

describe('BC-11: a park question leaves with its park', () => {
  it('stands the parks: each waits on a person on all three surfaces', async () => {
    for (const issue of [released, reopened, asked]) {
      expect(await openOn(issue.id)).not.toEqual([]);
    }
    expect(await homeDecisionKeys()).toEqual(
      expect.arrayContaining([released.key, reopened.key, asked.key]),
    );
    expect(await chatDecisionKeys()).toEqual(
      expect.arrayContaining([released.key, reopened.key, asked.key]),
    );
  });

  it('withdraws the question in the move back to awaiting_release, naming why', async () => {
    const [parkQuestion] = await openOn(released.id);
    await moveOn(released.id, 'awaiting_release', 'Released by hand; nothing waits on a person.');

    expect(await openOn(released.id), 'the park question is no longer open').toEqual([]);
    const shown = (await issueQuestions(released.id)).find((q) => q.id === parkQuestion);
    expect(shown?.status).toBe('void');
    expect(shown?.voidReason).toContain('Needs info');
    expect(shown?.voidReason).toContain('Awaiting release');
    expect(shown?.voidReason).toContain('Released by hand; nothing waits on a person.');
    expect(await homeDecisionKeys()).not.toContain(released.key);
    expect(await chatDecisionKeys()).not.toContain(released.key);
  });

  it('records the withdrawal as a question move in the same transaction as the issue move', async () => {
    const moves = await rows<{ entity: string; to_status: string; at: string }>(sql`
      SELECT k.entity, k.to_status, k.created_at::text AS at FROM kernel_transitions k
       WHERE (k.entity = 'issue' AND k.entity_id = ${released.id} AND k.from_status = 'needs_info')
          OR (k.entity = 'question' AND k.entity_id IN
                (SELECT id FROM agent_questions WHERE issue_id = ${released.id}) AND k.to_status = 'void')
       ORDER BY k.entity`);
    expect(moves.map((m) => [m.entity, m.to_status])).toEqual([
      ['issue', 'awaiting_release'],
      ['question', 'void'],
    ]);
    expect(moves[0]?.at, 'one transaction, one now()').toBe(moves[1]?.at);
  });

  it("withdraws ISS-439's case: Move anyway back to open", async () => {
    await moveOn(reopened.id, 'open', 'Design decisions recorded; nothing waits on a person.');
    expect(await openOn(reopened.id)).toEqual([]);
    expect(await homeDecisionKeys()).not.toContain(reopened.key);
    expect(await chatDecisionKeys()).not.toContain(reopened.key);
  });

  it('leaves a question somebody else asked during the park open: it is theirs', async () => {
    await moveOn(asked.id, 'open', 'Resumed by hand.');
    expect(await openOn(asked.id)).toEqual([ownQuestion]);
    expect(await homeDecisionKeys()).toContain(asked.key);
  });
});
