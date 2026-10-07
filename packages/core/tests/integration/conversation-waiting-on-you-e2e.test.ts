/**
 * ISS-277: a room whose agent ended its turn asking the person something waits on that person. The
 * list read only an open questionnaire batch as `waiting_on_you`, so a prose question ("shall I file
 * REQ-1?") read `done`, and the owner's answer went to a fresh chat with none of its context (FB-88).
 * Pass 2: a message that ends on a statement never claims the wait, whatever `?` it holds earlier, in
 * a quote or in code; and the wait is the asked person's, not every reader's.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let token = '';
let projectId = '';
let owner = '';
let colleague = '';
let colleagueToken = '';
let otherAgent = '';
let watcher = '';
let watcherToken = '';

/** A said message; a `user` one is the owner's unless `by` names another author. */
type Said = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  silence?: string;
  by?: string | null;
};

async function room(title: string, said: Said[], people: string[] = []): Promise<string> {
  const res = await api(token, 'POST', '/api/conversations', { projectId, title, people });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  for (const [i, m] of said.entries()) {
    const author = m.role === 'user' ? (m.by === undefined ? owner : m.by) : null;
    await db.execute(sql`
      INSERT INTO conversation_messages
        (conversation_id, seq, role, content, silence_reason, author_user_id)
      VALUES (${id}, ${i + 1}, ${m.role}, ${m.content}, ${m.silence ?? null}, ${author})
    `);
  }
  return id;
}

async function listed(as = token): Promise<Map<string, string | null>> {
  const res = await api(as, 'GET', `/api/conversations?projectId=${projectId}`);
  expect(res.status).toBe(200);
  const items = res.body.items as { id: string; threadStatus: string | null }[];
  return new Map(items.map((r) => [r.id, r.threadStatus]));
}

async function detailed(id: string, as = token): Promise<string | null> {
  const res = await api(as, 'GET', `/api/conversations/${id}`);
  expect(res.status).toBe(200);
  return res.body.threadStatus as string | null;
}

const asked = 'I drafted REQ-1 from what you described.\n\nShall I file it as written?';

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  token = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  colleague = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, colleague);
  colleagueToken = await userToken(colleague);
  otherAgent = (await createTestUser({ kind: 'agent' })).id;
  watcher = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, watcher, 'viewer');
  watcherToken = await userToken(watcher);
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

// the three false waits the independent judge reproduced through this endpoint at b1ba727
describe('a room whose agent ended on a statement, with a question mark earlier', () => {
  const endsOnStatement = {
    rhetorical: 'Why does this matter? Because the token expires, so the job now refreshes it.',
    quoted: 'I recorded your question "Can we ship on Friday?" in REQ-2.',
    ternary: 'Changed the default:\n\n```ts\nconst v = ok ? a : b;\n```',
    placeholder: 'The lookup now binds its id:\n\n```sql\nSELECT * FROM jobs WHERE id = ?\n```',
  };

  for (const [shape, content] of Object.entries(endsOnStatement)) {
    it(`reads done, not waiting on you: ${shape}`, async () => {
      const id = await room(shape, [
        { role: 'user', content: 'What changed?' },
        { role: 'assistant', content },
      ]);
      expect((await listed()).get(id)).toBe('done');
      expect(await detailed(id)).toBe('done');
    });
  }
});

describe('a question the agent put to one person in a room two people read', () => {
  it('waits on the person it answered, and not on the other reader', async () => {
    const id = await room(
      'asked the colleague',
      [
        { role: 'user', content: 'Draft REQ-4 for the export screen' },
        { role: 'user', content: 'Make it CSV only', by: colleague },
        { role: 'assistant', content: 'Shall I drop XLSX from REQ-4, then?' },
      ],
      [colleague],
    );
    expect((await listed(colleagueToken)).get(id)).toBe('waiting_on_you');
    expect(await detailed(id, colleagueToken)).toBe('waiting_on_you');
    expect((await listed()).get(id)).toBe('done');
    expect(await detailed(id)).toBe('done');
  });

  it('reads past another agent to the person it answered', async () => {
    const id = await room(
      'asked the owner past an agent',
      [
        { role: 'user', content: 'Draft REQ-5' },
        { role: 'user', content: 'Noted from the release agent.', by: otherAgent },
        { role: 'assistant', content: 'Shall I file REQ-5?' },
      ],
      [colleague],
    );
    expect((await listed()).get(id)).toBe('waiting_on_you');
    expect((await listed(colleagueToken)).get(id)).toBe('done');
  });

  it('waits on every person in the room when no person has spoken yet', async () => {
    const id = await room(
      'asked the room',
      [{ role: 'assistant', content: 'Who owns REQ-6?' }],
      [colleague],
    );
    expect((await listed()).get(id)).toBe('waiting_on_you');
    expect((await listed(colleagueToken)).get(id)).toBe('waiting_on_you');
  });
});

describe('an open questionnaire batch', () => {
  it('waits on a reader who may answer it, and not on one who may not', async () => {
    const id = await room('batch', [{ role: 'user', content: 'Clarify REQ-7' }], [watcher]);
    const requirementId = randomUUID();
    await db.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title)
      VALUES (${requirementId}, ${projectId}, 7, 'REQ-7')
    `);
    await db.execute(sql`
      INSERT INTO questionnaire_batches
        (project_id, conversation_id, requirement_id, title, round, status, posted_by, posted_agency)
      VALUES (${projectId}, ${id}, ${requirementId}, 'Clarify REQ-7', 1, 'open', ${owner}, 'human')
    `);
    expect((await listed()).get(id)).toBe('waiting_on_you');
    expect((await listed(watcherToken)).get(id)).toBe('done');
    expect(await detailed(id, watcherToken)).toBe('done');
  });
});
