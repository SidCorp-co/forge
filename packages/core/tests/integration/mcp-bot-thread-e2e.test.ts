/**
 * REQ-91 (ISS-1115): an MCP client converses with the Forge bot in a persistent project thread,
 * through `forge_call` on /mcp under a real token. The thread is a web room and each turn the chat
 * assistant's real window routing; only the model is scripted, and a gate holds it to make a turn
 * outlast the call. Each refusal is asked by the call a client would make.
 *
 * @direct-test-of packages/core/src/product-door/bot-tool.ts
 * @direct-test-of packages/core/src/assistant/bot-actions.ts
 * @direct-test-of packages/core/src/assistant/bot-thread.ts
 * @direct-test-of packages/core/src/assistant/conversation-send.ts
 * @direct-test-of packages/core/src/conversations/keyed-messages.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/** What each turn put in front of the model, and how the next one answers. */
const seen: unknown[][] = [];
let gate: Promise<void> | null = null;
let failNext = false;

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatModelName: () => 'scripted',
  openChat: async () => ({
    model: 'scripted',
    provider: {
      id: 'scripted',
      defaultModel: 'scripted',
      async *stream(req: { messages: unknown[] }) {
        seen.push(req.messages);
        if (gate) await gate;
        if (failNext) {
          failNext = false;
          throw new Error('scripted model failure');
        }
        yield { type: 'chunk', text: `Answer ${seen.length}.` };
        yield { type: 'done' };
      },
    },
  }),
}));

const { db } = await import('../../src/db/client.js');
const { mintPat } = await import('../../src/credentials/pat.js');
const { PAT_GRANT_EPOCH } = await import('../../src/credentials/pat-permissions.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestProject, createTestRequirement, createTestUser, rows } =
  await import('../helpers/factories.js');

type Body = Record<string, unknown>;
interface Called {
  isError: boolean;
  text: string;
  body: Body;
}

async function call(token: string, action: string, args: Body): Promise<Called> {
  const res = await api(
    token,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_call', arguments: { action, args } },
    },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text?: string }[]; isError?: boolean } })
    .result;
  const text = result.content.map((c) => c.text ?? '').join('\n');
  let body: Body = {};
  try {
    body = JSON.parse(result.content[0]?.text ?? '') as Body;
  } catch {}
  return { isError: result.isError === true, text, body };
}

const pat = async (userId: string, permissions: string[], projectIds: string[] | null = null) =>
  (
    await mintPat({
      permissions: permissions as never,
      userId,
      name: `iss-1115-${randomUUID().slice(0, 8)}`,
      projectIds,
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;

let owner = '';
let token = '';
let projectId = '';
let otherProject = '';

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  otherProject = (await createTestProject(owner)).id;
  await createTestRequirement(projectId, 90, 'Unblock the release train');
  token = await pat(owner, ['*']);
});

async function openThread(t = token, project = projectId): Promise<string> {
  const opened = await call(t, 'bot.open', { projectId: project, title: 'mcp thread' });
  expect(opened.isError, opened.text).toBe(false);
  return opened.body.thread as string;
}

const userRows = async (thread: string) =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${thread} AND role = 'user'`,
    )
  )[0]?.n;

describe('a project thread with the Forge bot over MCP (REQ-91)', () => {
  it('asks about an item, gets the real turn, follows up in the same thread, and the UI reads it (BC-1..3, BC-7)', async () => {
    const thread = await openThread();
    const before = seen.length;
    const sent = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'what blocks this?',
      clientKey: 'q-1',
      about: { kind: 'requirement', key: 'REQ-90' },
    });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.body.processing).toBe(false);
    expect((sent.body.turn as Body).state).toBe('completed');
    const replies = sent.body.messages as Body[];
    expect(replies.map((m) => m.role)).toEqual(['assistant']);
    expect(seen.length).toBe(before + 1);
    // the turn was told the record the client named, the way the UI's page beside the chat names it
    expect(JSON.stringify(seen.at(-1))).toContain('REQ-90');

    const follow = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'and after that?',
      clientKey: 'q-2',
    });
    expect((follow.body.turn as Body).state).toBe('completed');
    // the follow-up's turn reads the first exchange: one thread, one memory
    expect(JSON.stringify(seen.at(-1))).toContain('what blocks this?');

    const ui = await api(await userToken(owner), 'GET', `/api/conversations/${thread}`);
    expect(ui.status).toBe(200);
    const contents = (ui.body.messages as Body[]).map((m) => m.content);
    expect(contents).toContain('what blocks this?');
    expect(contents).toContain('and after that?');

    const listed = await call(token, 'bot.threads', { projectId });
    expect((listed.body.threads as Body[]).map((t) => t.thread)).toContain(thread);
  });

  it('answers a turn that outlasts the call as processing, and a later read yields it without a second turn (BC-4)', async () => {
    const thread = await openThread();
    let release = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });
    const before = seen.length;
    const sent = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'a long one',
      clientKey: 'long-1',
      waitSeconds: 0,
    });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.body.processing).toBe(true);
    expect(['queued', 'running']).toContain((sent.body.turn as Body).state);
    const turn = (sent.body.turn as Body).id as string;

    const early = await call(token, 'bot.read', { projectId, thread, turn, waitSeconds: 0 });
    expect(early.body.processing).toBe(true);

    gate = null;
    release();
    // a read answers as soon as a message lands after the cursor, and the reply can land before its
    // turn reads settled, so the caller follows the cursor until it does, as bot.read's next says
    let cursor = sent.body.cursor;
    const messages: Body[] = [];
    let late: Called;
    for (let reads = 0; ; reads++) {
      late = await call(token, 'bot.read', {
        projectId,
        thread,
        turn,
        after: cursor,
        waitSeconds: 10,
      });
      expect(late.isError, late.text).toBe(false);
      messages.push(...(late.body.messages as Body[]));
      cursor = late.body.cursor;
      if (!late.body.processing || reads === 5) break;
    }
    expect((late.body.turn as Body).state).toBe('completed');
    expect(messages.at(-1)?.role).toBe('assistant');
    expect(seen.length).toBe(before + 1);
  });

  it('reads a failed turn as failed, with its reason', async () => {
    const thread = await openThread();
    failNext = true;
    const sent = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'this one breaks',
      clientKey: 'fail-1',
      waitSeconds: 10,
    });
    expect((sent.body.turn as Body).state).toBe('failed');
    expect(String((sent.body.turn as Body).reason)).toMatch(/\S/);
  });

  it('reads a reply that asks the person as needs-input, and takes the answer in the same thread (BC-3)', async () => {
    const thread = await openThread();
    const sent = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'file it',
      clientKey: 'ask-1',
    });
    const reply = (sent.body.messages as Body[]).at(-1)?.id as string;
    // the record a turn that called await_reply leaves (ISS-277), written as that turn writes it
    await db.execute(
      sql`UPDATE conversation_messages SET awaits_reply = true, awaits_reply_from = ${owner} WHERE id = ${reply}`,
    );
    const read = await call(token, 'bot.read', {
      projectId,
      thread,
      turn: (sent.body.turn as Body).id,
      waitSeconds: 0,
    });
    expect((read.body.turn as Body).state).toBe('needs-input');
    expect((read.body.messages as Body[]).at(-1)?.awaitsReply).toBe(true);

    const answered = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'yes, as feedback',
      clientKey: 'ask-2',
    });
    expect((answered.body.turn as Body).state).toBe('completed');
  });
});

describe('a retried send is taken in once (BC-6)', () => {
  it('answers the first turn to a retry under the same key, and writes no second message or turn', async () => {
    const thread = await openThread();
    const before = seen.length;
    const args = { projectId, thread, message: 'once only', clientKey: 'retry-1' };
    const first = await call(token, 'bot.send', args);
    const again = await call(token, 'bot.send', args);
    expect(again.isError, again.text).toBe(false);
    expect(again.body.duplicate).toBe(true);
    expect((again.body.turn as Body).id).toBe((first.body.turn as Body).id);
    expect(await userRows(thread)).toBe(1);
    expect(seen.length).toBe(before + 1);
  });

  it('takes two concurrent sends under one key in once', async () => {
    const thread = await openThread();
    const args = { projectId, thread, message: 'raced', clientKey: 'race-1' };
    const [a, b] = await Promise.all([
      call(token, 'bot.send', args),
      call(token, 'bot.send', args),
    ]);
    expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
    expect(await userRows(thread)).toBe(1);
  });

  it('refuses the same key with other text by name', async () => {
    const thread = await openThread();
    await call(token, 'bot.send', { projectId, thread, message: 'first', clientKey: 'k' });
    const other = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'second',
      clientKey: 'k',
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('BOT_CLIENT_KEY_REUSED');
    expect(await userRows(thread)).toBe(1);
  });
});

describe('the caller’s own authority bounds every thread read and write (BC-6)', () => {
  it('refuses a thread of another project named under this one', async () => {
    const thread = await openThread(token, otherProject);
    for (const action of ['bot.read', 'bot.send', 'bot.open']) {
      const r = await call(token, action, {
        projectId,
        thread,
        message: 'x',
        clientKey: `cross-${action}`,
      });
      expect(r.isError, `${action}: ${r.text}`).toBe(true);
      expect(r.text).toContain('BOT_THREAD_NOT_IN_PROJECT');
    }
    expect(await userRows(thread)).toBe(0);
  });

  it('refuses a token fenced to one project a thread of another', async () => {
    const fenced = await pat(owner, ['*'], [otherProject]);
    const r = await call(fenced, 'bot.open', { projectId });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('NOT_FOUND');
  });

  it('gives no way to speak as someone else, and refuses another person’s thread', async () => {
    const thread = await openThread();
    const asSomeone = await call(token, 'bot.send', {
      projectId,
      thread,
      message: 'as them',
      clientKey: 'id-1',
      userId: owner,
    });
    expect(asSomeone.isError).toBe(true);
    expect(asSomeone.text).toContain('userId');

    const colleague = (await createTestUser({ verified: true })).id;
    await addProjectMember(projectId, colleague, 'member');
    const theirs = await pat(colleague, ['*']);
    const read = await call(theirs, 'bot.read', { projectId, thread, waitSeconds: 0 });
    expect(read.isError).toBe(true);
    const sent = await call(theirs, 'bot.send', {
      projectId,
      thread,
      message: 'hijack',
      clientKey: 'id-2',
    });
    expect(sent.isError).toBe(true);
    expect(await userRows(thread)).toBe(0);
  });

  it('refuses a send to a token granted only reads, and an open to a viewer', async () => {
    const thread = await openThread();
    const readOnly = await pat(owner, ['assistant:read', 'projects:read']);
    const sent = await call(readOnly, 'bot.send', {
      projectId,
      thread,
      message: 'no',
      clientKey: 'perm-1',
    });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain('assistant:write');
    const read = await call(readOnly, 'bot.read', { projectId, thread, waitSeconds: 0 });
    expect(read.isError, read.text).toBe(false);

    const viewer = (await createTestUser({ verified: true })).id;
    await addProjectMember(projectId, viewer, 'viewer');
    const opened = await call(await pat(viewer, ['*']), 'bot.open', { projectId });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain('project.write');
    expect(await userRows(thread)).toBe(0);
  });
});
