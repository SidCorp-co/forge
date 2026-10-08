import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { webConversationPorts } from '../../src/assistant/conversation-adapter.js';
import { codeAuthored, recordDeliveredReply } from '../../src/conversations/index.js';
import { db } from '../../src/db/client.js';
import { conversations } from '../../src/db/schema-conversations.js';
import type { ContentBlock } from '../../src/lib/agent-stream-parser.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

// A delivered reply's tool calls ran with the asker's permissions, so their inputs, their outputs,
// the act buttons they offer and the reasoning around them are the asker's (REQ-32, lane A8d). Every
// other member of the room reads the tools by name and time, and the reply — over REST, and over the
// socket that tells them a reply arrived.

const INPUT_SECRET = 'ninety per cent of REQ-4, from the hidden board';
const OUTPUT_SECRET = 'salary band row for Linh: 4,200';
const THOUGHT_SECRET = 'the admin-only release note says to hold';
const OFFER_SECRET = 'admit ISS-77 from the private triage';
const REPLY = 'REQ-4 has three of four criteria agreed.';

const TOOL_BLOCKS: ContentBlock[] = [
  { type: 'thinking', thinking: THOUGHT_SECRET, durationMs: 1200 },
  {
    type: 'tool',
    toolCall: {
      id: 'call-1',
      name: 'forge_show',
      input: { block: { kind: 'status-list', frame: { label: INPUT_SECRET } } },
      output: OUTPUT_SECRET,
      durationMs: 420,
    },
  },
  {
    type: 'tool',
    toolCall: {
      id: 'call-2',
      name: 'offer_act',
      input: { act: 'admit', key: 'ISS-77' },
      output: JSON.stringify({ offer: OFFER_SECRET }),
      durationMs: 35,
    },
  },
  { type: 'text', text: REPLY },
];
const SECRETS = [INPUT_SECRET, OUTPUT_SECRET, THOUGHT_SECRET, OFFER_SECRET];

interface Person {
  id: string;
  token: string;
}
let projectId: string;
let asker: Person;
let other: Person;
let roomId: string;
let externalId: string;
let messageId: string;

const person = async (role: 'admin' | 'member') => {
  const u = await createTestUser({ verified: true });
  await addProjectMember(projectId, u.id, role);
  return { id: u.id, token: await userToken(u.id) };
};
const replyAs = async (who: Person) => {
  const res = await api(who.token, 'GET', `/api/conversations/${roomId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const found = (res.body.messages as Body[]).find((m) => m.id === messageId);
  if (!found) throw new Error(`reply ${messageId} is not in the room read`);
  return found;
};
const pushedTo = async (userId: string) => {
  const rows = await db.execute<{ payload: Body }>(sql`
    SELECT payload FROM pipeline_outbox
    WHERE type = 'conversation.pushed' AND payload ->> 'conversationId' = ${roomId}`);
  return rows
    .map((r) => r.payload)
    .filter((p) => ((p.userIds as string[] | undefined) ?? []).includes(userId));
};

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  projectId = (await createTestProject(owner.id)).id;
  asker = await person('admin');
  other = await person('member');
  const opened = await api(asker.token, 'POST', '/api/conversations', {
    projectId,
    title: 'where it stands',
    people: [other.id],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  roomId = String(opened.body.id);
  const [row] = await db
    .select({ externalId: conversations.externalId, shape: conversations.shape })
    .from(conversations)
    .where(eq(conversations.id, roomId));
  externalId = String(row?.externalId);

  // the turn's delivery, as `assistant/turn-runner.ts` makes it: the transport tells the room, then
  // the transcript records the reply with the blocks the turn accumulated and whose turn it was
  const venue = { adapter: 'web' as const, externalId, shape: row?.shape ?? 'group', projectId };
  const receipt = await webConversationPorts.deliver(venue, codeAuthored(REPLY));
  await recordDeliveredReply({
    conversationId: roomId,
    projectId,
    text: REPLY,
    receipt,
    deliveryKey: 'window:tool-content',
    askedBy: asker.id,
    blocks: TOOL_BLOCKS,
  });
  const [stored] = await db.execute<{ id: string }>(sql`
    SELECT id FROM conversation_messages
    WHERE conversation_id = ${roomId} AND role = 'assistant' AND content = ${REPLY}`);
  messageId = String(stored?.id);
}, 120_000);

describe("a delivered reply's tool content", () => {
  it('is read whole by the person whose turn it was', async () => {
    const mine = await replyAs(asker);
    const said = JSON.stringify(mine);
    for (const secret of SECRETS) expect(said).toContain(secret);
    expect(mine.content).toBe(REPLY);
  });

  it("is withheld from another member's REST read, who reads the tools by name and time", async () => {
    const theirs = await replyAs(other);
    const said = JSON.stringify(theirs);
    for (const secret of SECRETS) expect(said).not.toContain(secret.slice(0, 20));
    expect(theirs.content).toBe(REPLY);
    expect(theirs.blocks).toEqual([
      { type: 'thinking', durationMs: 1200 },
      {
        type: 'tool',
        toolCall: { id: 'call-1', name: 'forge_show', durationMs: 420, withheld: true },
      },
      {
        type: 'tool',
        toolCall: { id: 'call-2', name: 'offer_act', durationMs: 35, withheld: true },
      },
      { type: 'text', text: REPLY },
    ]);
  });

  it("never reaches another member's socket: the frame that tells them of the reply holds its words only", async () => {
    const frames = await pushedTo(other.id);
    expect(frames.length).toBeGreaterThan(0);
    const said = JSON.stringify(frames);
    for (const secret of SECRETS) expect(said).not.toContain(secret.slice(0, 20));
    expect(said).toContain(REPLY);
  });

  it('is withheld from everyone where the delivery named no asker', async () => {
    await db.execute(sql`
      UPDATE conversation_messages SET delivery_proof = delivery_proof - 'askedBy' WHERE id = ${messageId}`);
    for (const who of [asker, other]) {
      const said = JSON.stringify(await replyAs(who));
      for (const secret of SECRETS) expect(said).not.toContain(secret.slice(0, 20));
    }
  });
});
