/**
 * ISS-277: a room whose agent ended its turn asking the person something waits on that person. The
 * list read only an open questionnaire batch as `waiting_on_you`, so a prose question ("shall I file
 * REQ-1?") read `done`, and the owner's answer went to a fresh chat with none of its context (FB-88).
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let token = '';
let projectId = '';

type Said = { role: 'user' | 'assistant' | 'system'; content: string; silence?: string };

async function room(title: string, said: Said[]): Promise<string> {
  const res = await api(token, 'POST', '/api/conversations', { projectId, title });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  for (const [i, m] of said.entries()) {
    await db.execute(sql`
      INSERT INTO conversation_messages (conversation_id, seq, role, content, silence_reason)
      VALUES (${id}, ${i + 1}, ${m.role}, ${m.content}, ${m.silence ?? null})
    `);
  }
  return id;
}

async function listed(): Promise<Map<string, string | null>> {
  const res = await api(token, 'GET', `/api/conversations?projectId=${projectId}`);
  expect(res.status).toBe(200);
  const items = res.body.items as { id: string; threadStatus: string | null }[];
  return new Map(items.map((r) => [r.id, r.threadStatus]));
}

const asked = 'I drafted REQ-1 from what you described.\n\nShall I file it as written?';

beforeAll(async () => {
  const owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
});

describe('a room the agent left on a question', () => {
  it('reads waiting on you in the list and on the room', async () => {
    const id = await room('asked', [
      { role: 'user', content: 'Draft REQ-1 for the export screen' },
      { role: 'assistant', content: asked },
    ]);
    expect((await listed()).get(id)).toBe('waiting_on_you');
    const detail = await api(token, 'GET', `/api/conversations/${id}`);
    expect(detail.body.threadStatus).toBe('waiting_on_you');
  });

  it('still waits when the agent then chose to say nothing', async () => {
    const id = await room('asked then silent', [
      { role: 'user', content: 'Draft REQ-1' },
      { role: 'assistant', content: asked },
      { role: 'assistant', content: '', silence: 'nothing-to-say' },
    ]);
    expect((await listed()).get(id)).toBe('waiting_on_you');
  });

  it('reads the question before a closing list of options', async () => {
    const id = await room('options', [
      { role: 'user', content: 'Which export format?' },
      { role: 'assistant', content: 'Which one should I use?\n\n- CSV\n- XLSX' },
    ]);
    expect((await listed()).get(id)).toBe('waiting_on_you');
  });
});

describe('a room that does not wait on the person', () => {
  it('reads done when the agent ended on a statement', async () => {
    const id = await room('answered', [
      { role: 'user', content: 'Is REQ-1 filed?' },
      { role: 'assistant', content: 'Yes. REQ-1 is filed and approved.' },
    ]);
    expect((await listed()).get(id)).toBe('done');
  });

  it('stops waiting once the person answered the question', async () => {
    const id = await room('replied', [
      { role: 'assistant', content: asked },
      { role: 'user', content: 'Đồng ý' },
    ]);
    expect((await listed()).get(id)).not.toBe('waiting_on_you');
  });

  it('does not read a question mark inside a link or an earlier paragraph as the question', async () => {
    const id = await room('link', [
      { role: 'user', content: 'Where is it?' },
      {
        role: 'assistant',
        content:
          'Why did it fail? The token had expired.\n\nIt is at https://forge.test/r?id=1 now.',
      },
    ]);
    expect((await listed()).get(id)).toBe('done');
  });
});
