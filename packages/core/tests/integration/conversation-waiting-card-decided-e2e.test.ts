/**
 * A reply that awaits the person's answer and whose turn held cards is answered by deciding them.
 * Pressing Record it or Decline writes no conversation message, so before this the reply stayed the
 * room's newest and the room read "Waiting on you" for ever (forge-dev rooms 2391f37a and 5dac59ee,
 * cards declined 2026-10-09 and 2026-10-10). The mark is read, never written, so a room already stuck
 * clears with no backfill: every case here is rows as they stand, and one is the real Decline press.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let token = '';
let projectId = '';
let owner = '';
let colleague = '';
let colleagueToken = '';

type Card = 'pending' | 'declined' | 'agreed' | 'recorded' | 'failed';

/** A said message, or a card the turn writing the next agent reply held for `to` (the owner by default). */
type Row =
  | { role: 'user' | 'assistant'; content: string; asks?: string; by?: string }
  | { card: Card; to?: string };

const ASK = 'I drafted Feedback for the dock. Press Record it or Decline on the card.';

/** Writes the rows a second apart, in order, so a card falls inside the turn that held it. */
async function room(title: string, said: Row[], people: string[] = []): Promise<string> {
  const res = await api(token, 'POST', '/api/conversations', { projectId, title, people });
  expect(res.status).toBe(201);
  const id = (res.body as { id: string }).id;
  const start = Date.now() - said.length * 1000;
  let seq = 0;
  for (const [i, r] of said.entries()) {
    const at = new Date(start + i * 1000).toISOString();
    if ('card' in r) {
      await card(id, r.card, r.to ?? owner, at);
      continue;
    }
    seq += 1;
    await db.execute(sql`
      INSERT INTO conversation_messages
        (conversation_id, seq, role, content, author_user_id, awaits_reply, awaits_reply_from,
         created_at)
      VALUES (${id}, ${seq}, ${r.role}, ${r.content}, ${r.role === 'user' ? (r.by ?? owner) : null},
        ${r.asks !== undefined}, ${r.asks ?? null}, ${at})
    `);
  }
  return id;
}

async function card(conversationId: string, status: Card, to: string, at: string): Promise<string> {
  const id = randomUUID();
  const decided = status !== 'pending';
  const agreed = status === 'agreed' || status === 'recorded' || status === 'failed';
  await db.execute(sql`
    INSERT INTO chat_proposals
      (id, project_id, conversation_id, proposed_to, kind, form, call, summary, status, agreed_via,
       decided_by, decided_at, created_at)
    VALUES (${id}, ${projectId}, ${conversationId}, ${to}, 'feedback', 'tool',
      ${JSON.stringify({ name: 'forge_feedback', arguments: '{}' })}::jsonb,
      ${JSON.stringify({ title: 'Feedback (bug): the dock loses a draft' })}::jsonb, ${status},
      ${agreed ? 'card' : null}, ${decided ? to : null}, ${decided ? at : null}, ${at})
  `);
  return id;
}

async function marked(
  id: string,
  as = token,
): Promise<{ list: string | null | undefined; room: string }> {
  const list = await api(as, 'GET', `/api/conversations?projectId=${projectId}`);
  expect(list.status).toBe(200);
  const items = list.body.items as { id: string; threadStatus: string | null }[];
  const detail = await api(as, 'GET', `/api/conversations/${id}`);
  expect(detail.status).toBe(200);
  return {
    list: items.find((r) => r.id === id)?.threadStatus,
    room: detail.body.threadStatus as string,
  };
}

const both = (status: string) => ({ list: status, room: status });

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  colleague = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, colleague);
  colleagueToken = await userToken(colleague);
});

describe('a reply awaiting the person, whose turn held a card', () => {
  for (const decided of ['declined', 'agreed', 'recorded', 'failed'] as const) {
    it(`is answered once the card is ${decided}: the room reads done`, async () => {
      const id = await room(`card ${decided}`, [
        { role: 'user', content: 'The dock loses my draft. Record it.' },
        { card: decided },
        { role: 'assistant', content: ASK, asks: owner },
      ]);
      expect(await marked(id)).toEqual(both('done'));
    });
  }

  it('still waits on the person while the card is pending', async () => {
    const id = await room('card pending', [
      { role: 'user', content: 'The dock loses my draft. Record it.' },
      { card: 'pending' },
      { role: 'assistant', content: ASK, asks: owner },
    ]);
    expect(await marked(id)).toEqual(both('waiting_on_you'));
  });

  it('still waits while any one of the cards its turn held is pending', async () => {
    const id = await room('one of two pending', [
      { role: 'user', content: 'Record both.' },
      { card: 'declined' },
      { card: 'pending' },
      { role: 'assistant', content: ASK, asks: owner },
    ]);
    expect(await marked(id)).toEqual(both('waiting_on_you'));
  });

  it('clears when the person presses Decline on the card', async () => {
    const id = await room('declined by the press', [
      { role: 'user', content: 'The dock loses my draft. Record it.' },
      { card: 'pending' },
      { role: 'assistant', content: ASK, asks: owner },
    ]);
    expect(await marked(id)).toEqual(both('waiting_on_you'));
    const [held] = (await db.execute(
      sql`SELECT id FROM chat_proposals WHERE conversation_id = ${id}`,
    )) as unknown as { id: string }[];
    const res = await api(token, 'POST', `/api/conversations/${id}/proposals/${held?.id}/decline`);
    expect(res.status).toBe(200);
    expect(await marked(id)).toEqual(both('done'));
  });
});

describe('a reply awaiting the person that a decided card does not answer', () => {
  it('still waits when its turn held no card', async () => {
    const id = await room('no card', [
      { role: 'user', content: 'Draft REQ-1' },
      { role: 'assistant', content: 'Shall I file REQ-1 as written?', asks: owner },
    ]);
    expect(await marked(id)).toEqual(both('waiting_on_you'));
  });

  it('still waits when the only decided card belongs to an earlier turn', async () => {
    const id = await room('card from an earlier turn', [
      { role: 'user', content: 'The dock loses my draft. Record it.' },
      { card: 'declined' },
      { role: 'assistant', content: 'Declined, nothing was written.' },
      { role: 'user', content: 'Draft REQ-1 instead' },
      { role: 'assistant', content: 'Shall I file REQ-1 as written?', asks: owner },
    ]);
    expect(await marked(id)).toEqual(both('waiting_on_you'));
  });

  it('still waits on the viewer when the decided card was put to someone else', async () => {
    const id = await room(
      'card put to the colleague',
      [
        { role: 'user', content: 'Record it for both of us.' },
        { card: 'declined', to: colleague },
        { role: 'assistant', content: ASK, asks: owner },
      ],
      [colleague],
    );
    expect(await marked(id)).toEqual(both('waiting_on_you'));
    expect((await marked(id, colleagueToken)).room).toBe('done');
  });

  it('still waits on the viewer whose own card is pending beside a decided card put to another', async () => {
    const id = await room(
      'mine pending, theirs declined',
      [
        { role: 'user', content: 'Record it for both of us.' },
        { card: 'declined', to: colleague },
        { card: 'pending' },
        { role: 'assistant', content: ASK, asks: owner },
      ],
      [colleague],
    );
    expect(await marked(id)).toEqual(both('waiting_on_you'));
  });
});
