import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { projectDocumentSchema } from '../../src/project-config/schema.js';
import { DEFAULT_GRANT, grantsOf } from '../../src/support/grants.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/technical-channel.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/project-config/schema.ts
// @direct-test-of packages/contracts/src/support-technical.ts
// @direct-test-of packages/core/tests/helpers/support-chat-server.ts
// @direct-test-of packages/core/src/support/permission-talk.ts
// @direct-test-of packages/core/src/support/screen.ts
// @direct-test-of packages/core/src/support/act-deny.ts
// @direct-test-of packages/core/src/support/grants.ts
// @direct-test-of packages/core/src/support/one-voice.ts
// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/thread-requests.ts
//
// ISS-1243 item 13 (owner 2026-11-15): a project names exactly one technical channel, its own thread
// of the shared operations room or a direct message to one person (the owner by default), and a room
// agent raises every permission, approval, finding and ask of the owner there and nowhere else: the
// asker's thread is posted nothing. A channel Forge cannot reach is refused by name.

const w = new AgentWorld();

beforeAll(async () => {
  await w.openAgent();
}, 120_000);

afterAll(() => w.stop());

async function setChannel(channel: unknown): Promise<void> {
  await db.execute(
    channel === null
      ? sql`UPDATE project_config_documents SET document = document - 'technicalChannel', revision = revision + 1 WHERE project_id = ${w.projectId}`
      : sql`UPDATE project_config_documents SET document = jsonb_set(document, '{technicalChannel}', ${JSON.stringify(channel)}::jsonb), revision = revision + 1 WHERE project_id = ${w.projectId}`,
  );
}

async function raise(text: string, need = 'permission') {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => w.stand.say(w.stand.bob, 'please share the sales mailbox with me'),
    async (_t, act, message) => {
      out = await act({ action: 'technical', thread: message().thread, need, text });
    },
  );
  return { out, thread: heard.id };
}

describe('a room agent raises what it needs in the one technical channel, and nowhere else', () => {
  it('names no channel: a direct message to the owner the binding names, nothing in the thread', async () => {
    await setChannel(null);
    const { out, thread } = await raise('I need the mailbox share grant for bob');
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(out.channel).toBe('dm');
    // the owner is u-alice; the stand-in opens D-<username>
    const dm = w.stand.linesIn('D-alice');
    expect(dm.map((l) => l.text).join('\n')).toContain('I need the mailbox share grant for bob');
    // ISS-1249: the project's name and the need in plain words, then the agent's, and no id
    const project = w.projectName;
    expect(dm.at(-1)?.text).toBe(
      `${project} asks for a permission: I need the mailbox share grant for bob`,
    );
    expect(dm.at(-1)?.text).not.toContain(thread);
    expect(dm.at(-1)?.text).not.toContain(w.stand.rid);
    expect(w.threadLines(w.stand.rid, thread)).toEqual([]);
    const routed = await rows<{ tool: string; output: Record<string, unknown> }>(
      sql`SELECT tool, output FROM support_actions WHERE kind = 'routed' AND thread = ${thread}`,
    );
    expect(routed).toEqual([
      expect.objectContaining({
        tool: 'technical',
        output: expect.objectContaining({ channel: 'dm', rid: 'D-alice' }),
      }),
    ]);
  });

  it('a direct message to the person the project names', async () => {
    await setChannel({ kind: 'dm', user: w.stand.bob.userId });
    const { out } = await raise('the MX record is wrong for lighthouse', 'finding');
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(w.stand.linesIn('D-bob').at(-1)?.text).toContain('the MX record is wrong');
  });

  it('refuses by name a shared thread no binding records, and posts nothing anywhere', async () => {
    await setChannel({ kind: 'thread' });
    const before = (await w.stand.botLines()).length;
    const { out, thread } = await raise('may I deploy the fix?', 'approval');
    expect(code(out)).toBe('SUPPORT_TECHNICAL_CHANNEL_UNNAMED');
    expect(JSON.stringify(out)).toContain('technicalChannel');
    expect((await w.stand.botLines()).length).toBe(before);
    expect(w.threadLines(w.stand.rid, thread)).toEqual([]);
  });

  it('a project names exactly one channel, of a shape the document refuses by name otherwise', () => {
    const base = { ...(projectDocumentSchema.shape as object) };
    expect(base).toHaveProperty('technicalChannel');
    const shape = projectDocumentSchema.shape.technicalChannel;
    expect(shape.safeParse({ kind: 'thread' }).success).toBe(true);
    expect(shape.safeParse({ kind: 'dm' }).success).toBe(true);
    expect(shape.safeParse([{ kind: 'thread' }, { kind: 'dm' }]).success).toBe(false);
    expect(shape.safeParse({ kind: 'thread', user: 'u-x' }).success).toBe(false);
    expect(shape.safeParse({ kind: 'email' }).success).toBe(false);
  });
});

// ISS-1243 item 12: a work thread is never told the agent lacks a permission or waits on a grant
// (sid-email 06/11, in Vietnamese: no permission yet to share the mailbox); the screen refuses it by name, naming
// the technical channel's door, and an answer about the user's own access still posts.
describe('no permission talk in a work thread', () => {
  it('refuses a post saying the agent lacks a permission, and posts the answer', async () => {
    const outs: Record<string, unknown>[] = [];
    const heard = await w.hear(
      () => w.stand.say(w.stand.bob, 'can you share the sales mailbox with me?'),
      async (_t, act, message) => {
        const thread = message().thread;
        for (const text of [
          'Dạ em chưa có quyền tự share mailbox ạ, nhờ anh Chương cấp quyền giúp em.', // i18n-allow: the Vietnamese permission claim being policed
          "I don't have permission to share mailboxes yet.",
          'Your account has no permission on that mailbox; I raised it and it is in hand.',
        ]) {
          outs.push(await act({ action: 'reply', thread, text }));
        }
      },
    );
    expect(code(outs[0])).toBe('SUPPORT_PERMISSION_TALK');
    expect(JSON.stringify(outs[0])).toContain('support.technical');
    expect(code(outs[1])).toBe('SUPPORT_PERMISSION_TALK');
    expect(outs[2]?.isError, JSON.stringify(outs[2])).toBe(false);
    expect(w.threadLines(w.stand.rid, heard.id).map((l) => l.text)).toEqual([
      'Your account has no permission on that mailbox; I raised it and it is in hand.',
    ]);
    const refused = await rows<{ output: { code: string } }>(
      sql`SELECT output FROM support_actions WHERE kind = 'refused' AND thread = ${heard.id}`,
    );
    expect(refused.map((r) => r.output.code)).toEqual([
      'SUPPORT_PERMISSION_TALK',
      'SUPPORT_PERMISSION_TALK',
    ]);
  });
});

// ISS-1243 item 16: a room agent holds a support person's acts by default, and the project's deny list
// keeps the serious ones from it, each refused by name and raised in the technical channel.
describe('wide grants by default, with a deny list raised in the technical channel', () => {
  it('holds recording and moving work where its binding names no grant', () => {
    expect(grantsOf(null)).toEqual(DEFAULT_GRANT);
    expect(DEFAULT_GRANT.abilities).toEqual(['file_items', 'deliver']);
    expect(grantsOf({ grants: { abilities: [] } } as never).abilities).toEqual([]);
  });

  const setDoc = (path: string, value: unknown) =>
    db.execute(
      sql`UPDATE project_config_documents SET document = jsonb_set(document, ${`{${path}}`}::text[], ${JSON.stringify(value)}::jsonb), revision = revision + 1 WHERE project_id = ${w.projectId}`,
    );

  async function tryAct(args: Record<string, unknown>) {
    let out: Record<string, unknown> = {};
    const heard = await w.hear(
      () => w.stand.say(w.stand.bob, 'please do it'),
      async (_t, act, message) => {
        out = await act({ ...args, thread: message().thread });
      },
    );
    return { out, thread: heard.id };
  }

  it('refuses a production deploy and a data deletion by name, raising each in the technical channel', async () => {
    await setChannel(null);
    await setDoc('environments,dev,tier', 'production');
    const before = w.stand.linesIn('D-alice').length;
    const deploy = await tryAct({ action: 'deploy', target: w.devTarget });
    expect(code(deploy.out), JSON.stringify(deploy.out)).toBe('SUPPORT_ACT_DENIED');
    expect(JSON.stringify(deploy.out)).toContain('a production deploy');
    expect(JSON.stringify(deploy.out)).toContain('agentDeny');
    const wipe = await tryAct({
      action: 'command',
      host: 'web-1',
      command: 'rm -rf /var/data/orders',
    });
    expect(code(wipe.out), JSON.stringify(wipe.out)).toBe('SUPPORT_ACT_DENIED');
    const raised = w.stand
      .linesIn('D-alice')
      .slice(before)
      .map((l) => l.text);
    expect(raised).toHaveLength(2);
    expect(raised[0]).toContain('a production deploy');
    expect(raised[1]).toContain('deleting data');
    expect(w.threadLines(w.stand.rid, deploy.thread)).toEqual([]);
  });

  it('lets the project take an act off the list: an empty list denies none', async () => {
    await setDoc('agentDeny', []);
    const deploy = await tryAct({ action: 'deploy', target: w.devTarget });
    expect(deploy.out, JSON.stringify(deploy.out)).toMatchObject({ pending: true });
    await setDoc('environments,dev,tier', 'dev');
    await db.execute(
      sql`UPDATE project_config_documents SET document = document - 'agentDeny' WHERE project_id = ${w.projectId}`,
    );
  });
});

// ISS-1243 item 15 (AdminHub-Support: a room agent's reply and a master's post in one thread within
// ten minutes, 14 times; 7 corrections stacked): a master's post replaces the bot's answer to the
// current request in place, a correction replaces rather than stacks, and the agent then posts no
// second voice until the asker writes again.
describe('one voice per thread', () => {
  const masterPost = (text: string, thread: string) =>
    api(w.owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, {
      text,
      rid: w.stand.rid,
      thread,
    });

  it('replaces the agent’s answer, then its own, and leaves the agent no second post', async () => {
    const asked = await w.hear(
      () => w.stand.say(w.stand.bob, 'how do I export the month?'),
      async (_t, act, message) => {
        await act({
          action: 'reply',
          thread: message().thread,
          text: 'Open Reports, then Export.',
        });
      },
    );
    expect(w.threadLines(w.stand.rid, asked.id).map((l) => l.text)).toEqual([
      'Open Reports, then Export.',
    ]);
    const first = await masterPost('Open Reports, pick the month, then Export CSV.', asked.id);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ replaced: 'agent' });
    const fixed = await masterPost('Open Reports, pick the month, then Export XLSX.', asked.id);
    expect(fixed.body).toMatchObject({ replaced: 'master' });
    expect(w.threadLines(w.stand.rid, asked.id).map((l) => l.text)).toEqual([
      'Open Reports, pick the month, then Export XLSX.',
    ]);
    // the agent may not stack a second voice beside the master's until the asker writes again
    let again: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.bob, 'unrelated: is the shop open today?'),
      async (_t, act, message) => {
        again = await act({ action: 'reply', thread: asked.id, text: 'Use XLSX, as said.' });
        await act({ action: 'reply', thread: message().thread, text: 'Yes, until 18:00.' });
      },
    );
    expect(code(again), JSON.stringify(again)).toBe('SUPPORT_ONE_RESULT_PER_REQUEST');
    expect(w.threadLines(w.stand.rid, asked.id)).toHaveLength(1);
  });

  it('posts a new line once a member has written since the last answer', async () => {
    const asked = await w.hear(
      () => w.stand.say(w.stand.bob, 'where is the invoice list?'),
      async (_t, act, message) => {
        await act({ action: 'reply', thread: message().thread, text: 'Under Billing.' });
      },
    );
    await w.hear(() => w.stand.say(w.stand.bob, 'and the credit notes?', asked.id));
    const post = await masterPost('Credit notes are under Billing, second tab.', asked.id);
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    expect(post.body).not.toHaveProperty('replaced');
    expect(w.threadLines(w.stand.rid, asked.id).map((l) => l.text)).toEqual([
      'Under Billing.',
      'Credit notes are under Billing, second tab.',
    ]);
  });
});
