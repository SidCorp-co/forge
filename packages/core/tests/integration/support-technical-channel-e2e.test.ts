import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { projectDocumentSchema } from '../../src/project-config/schema.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/technical-channel.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/project-config/schema.ts
// @direct-test-of packages/contracts/src/support-technical.ts
// @direct-test-of packages/core/tests/helpers/support-chat-server.ts
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
    expect(dm.at(-1)?.text).toContain('· permission] from');
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
