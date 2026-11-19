import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { insertAction, roomsOfProject } from '../../src/support/store.js';
import { postTechnical } from '../../src/support/technical-channel.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';

// @direct-test-of packages/core/src/support/technical-channel.ts
// @direct-test-of packages/core/src/support/project-thread.ts
// @direct-test-of packages/core/src/project-config/binding-amend.ts
// @direct-test-of packages/core/src/support/thread.ts
// @direct-test-of packages/core/src/support/owner-ask.ts
// @direct-test-of packages/core/src/support/images.ts
// @direct-test-of packages/core/src/support/technical-thread-room.ts
// @direct-test-of packages/core/src/support/asker-read.ts
//
// ISS-1271 (owner 2026-11-17: Forge-Communicate is SidCorp's default technical channel): a project
// whose document names no technical channel raises in its own thread of the operations room its
// organization shares, opened on its first need as the room's bot and recorded on that room's
// binding, reused after, and opened once though two needs come at once. A direct message to the
// owner is the channel only where the organization binds no such room, or where the project names one.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona: 'You are Babo. You coordinate Forge and delivery for the team.',
  grants: ['read'],
};
const DM = 'D-alice';

const w = new AgentWorld();
/** The operations room the organization shares, bound by a sibling project as forge binds Forge-Communicate. */
let ops = '';
let opsBinding = '';
let slug = '';
let siblingId = '';
// a 1x1 PNG, as the owner's screenshot
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  await w.openAgent();
  ops = w.stand.rid3;
  [{ slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const sibling = await createTestProject(w.ownerId, { orgId: String(home?.org_id) });
  await addProjectMember(sibling.id, w.ownerId, 'owner');
  siblingId = sibling.id;
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: w.stand.serverUrl, role: BABO },
    secrets: { authToken: w.stand.bot.authToken, userId: w.stand.bot.userId },
    bindings: [
      {
        projectId: sibling.id,
        role: 'service',
        target: { provider: 'rocketchat', rids: [ops], operations: { scope: 'forge' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  const connection = String((rc.body.connection as { id: string }).id);
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${connection}::uuid`,
  );
  opsBinding = String(b?.id);
  await settleOutbox();
  await w.settleWarm();
  await db.execute(
    sql`UPDATE project_config_documents SET document = document - 'technicalChannel', revision = revision + 1 WHERE project_id = ${w.projectId}`,
  );
}, 120_000);

afterAll(() => w.stop());

/** The thread the shared room's binding records for the project now. */
async function recorded(): Promise<string | null> {
  const [row] = await rows<{ thread: string | null }>(sql`
    SELECT config #>> ${`{operations,threads,${ops},${slug}}`}::text[] AS thread
      FROM integration_bindings WHERE id = ${opsBinding}::uuid`);
  return row?.thread ?? null;
}

const topLevel = () => w.stand.linesIn(ops).filter((l) => !l.tmid);

async function raise(text: string) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => w.stand.say(w.stand.bob, 'please share the sales mailbox with me'),
    async (_t, act, message) => {
      out = await act({ action: 'technical', thread: message().thread, need: 'permission', text });
    },
  );
  return { out, thread: heard.id };
}

describe("ISS-1271: the organization's shared operations room is the default technical channel", () => {
  it("opens the project's thread there on its first need, records it on the binding, and posts the need in it", async () => {
    expect(await recorded()).toBeNull();
    const dmBefore = w.stand.linesIn(DM).length;
    const { out, thread } = await raise('I need the mailbox share grant for bob');
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(out).toMatchObject({ channel: 'thread', rid: ops });
    // one short line at the top level names the project as its people know it, never its slug
    const [header, ...more] = topLevel();
    expect([header?.text, more]).toEqual([`Technical · ${w.projectName}`, []]);
    expect(header?.text).not.toContain(slug);
    expect(await recorded()).toBe(header?.id);
    // the project's own thread names it already: the agent's words alone, no template lead (ISS-1299)
    expect(w.threadLines(ops, String(header?.id)).map((l) => l.text)).toEqual([
      'I need the mailbox share grant for bob',
    ]);
    // nothing in the owner's direct messages, nothing in the asker's thread
    expect(w.stand.linesIn(DM).length).toBe(dmBefore);
    expect(w.threadLines(w.stand.rid, thread)).toEqual([]);
  });

  it('reuses the recorded thread on a second need', async () => {
    const opened = await recorded();
    const { out } = await raise('and the archive mailbox too');
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(topLevel()).toHaveLength(1);
    expect(await recorded()).toBe(opened);
    expect(w.threadLines(ops, String(opened)).map((l) => l.text)).toHaveLength(2);
  });

  it('opens one thread though two needs come at once', async () => {
    await db.execute(
      sql`UPDATE integration_bindings SET config = config #- '{operations,threads}' WHERE id = ${opsBinding}::uuid`,
    );
    const before = topLevel().length;
    const room = (await roomsOfProject(w.projectId)).find((r) => r.rid === w.stand.rid);
    if (!room) throw new Error('the agent room was not declared');
    const [a, b] = await Promise.all([
      postTechnical(room, `${w.projectName} reports: the relay key expires`, '/need'),
      postTechnical(room, `${w.projectName} reports: the queue is backing up`, '/need'),
    ]);
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
    if (!a.ok || !b.ok) return;
    const opened = topLevel().slice(before);
    expect(opened).toHaveLength(1);
    expect(a.value.thread).toBe(opened[0]?.id);
    expect(b.value.thread).toBe(opened[0]?.id);
    expect(await recorded()).toBe(opened[0]?.id);
    expect(w.threadLines(ops, String(opened[0]?.id))).toHaveLength(2);
  });

  it('still sends a direct message where the project names one', async () => {
    await db.execute(
      sql`UPDATE project_config_documents SET document = jsonb_set(document, '{technicalChannel}', '{"kind":"dm"}'::jsonb), revision = revision + 1 WHERE project_id = ${w.projectId}`,
    );
    const opsBefore = w.stand.linesIn(ops).length;
    const { out } = await raise('may I restart the worker?');
    await db.execute(
      sql`UPDATE project_config_documents SET document = document - 'technicalChannel', revision = revision + 1 WHERE project_id = ${w.projectId}`,
    );
    expect(out).toMatchObject({ channel: 'dm', rid: DM });
    expect(w.stand.linesIn(DM).at(-1)?.text).toContain('may I restart the worker?');
    expect(w.stand.linesIn(ops).length).toBe(opsBefore);
  });

  it('sends a direct message to the owner where the organization binds no shared room', async () => {
    await db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE id = ${opsBinding}::uuid`,
    );
    const opsBefore = w.stand.linesIn(ops).length;
    const { out } = await raise('may I flush the cache?');
    await db.execute(
      sql`UPDATE integration_bindings SET active = true WHERE id = ${opsBinding}::uuid`,
    );
    expect(out).toMatchObject({ channel: 'dm', rid: DM });
    expect(w.stand.linesIn(DM).at(-1)?.text).toContain('may I flush the cache?');
    expect(w.stand.linesIn(ops).length).toBe(opsBefore);
  });

  it("ISS-1359: the room agent reads a picture its owner posted in the project's technical thread, and no other thread's", async () => {
    const own = await recorded();
    expect(own).not.toBeNull();
    const shared = (await roomsOfProject(siblingId)).find((r) => r.rid === ops);
    if (!shared) throw new Error('the shared operations room was not declared');
    // the owner's reply with a screenshot, recorded on the shared room's row as inbound records it
    const plant = async (externalId: string, thread: string) => {
      w.stand.uploads.set(externalId, { bytes: PNG, mime: 'image/png' });
      await insertAction({
        roomId: shared.id,
        projectId: shared.projectId,
        conversationId: null,
        kind: 'message_in',
        actorKind: 'member',
        actorKey: 'u-owner',
        actorLabel: 'owner',
        thread,
        externalId,
        input: {
          text: 'Cái nào ?',
          images: [
            {
              name: 'clip.png',
              mime: 'image/png',
              ref: `${w.stand.serverUrl}/file-upload/${externalId}/clip.png`,
            },
          ],
        },
      });
    };
    await plant('M-tech-own', String(own));
    await plant('M-tech-other', 'T-another-project');
    const reads: Record<string, unknown>[] = [];
    await w.hear(
      () => w.stand.say(w.stand.bob, 'what did the owner show?'),
      async (_t, act) => {
        reads.push(await act({ action: 'image', message: 'M-tech-own', n: 1 }));
        reads.push(await act({ action: 'image', message: 'M-tech-other', n: 1 }));
        reads.push(await act({ action: 'image', message: 'M-tech-other', n: 1, rid: w.stand.rid }));
      },
    );
    const [mine, unnamed, other] = reads as [
      Record<string, unknown> & { content?: { type: string; data?: string; mimeType?: string }[] },
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // read through Forge with the shared room's bot, bytes and type intact
    expect(mine.isError, JSON.stringify(mine)).toBe(false);
    const block = mine.content?.find((c) => c.type === 'image');
    expect(block?.mimeType).toBe('image/png');
    expect(Buffer.from(block?.data ?? '', 'base64')).toEqual(PNG);
    // another thread of the shared room stays out of reach: no group of the session holds it, and
    // named in the agent's own group it is refused by name, saying where it is
    expect(unnamed.isError).toBe(true);
    expect(JSON.stringify(unnamed)).toContain('SUPPORT_ROOM_AMBIGUOUS');
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other)).toContain('SUPPORT_MESSAGE_UNKNOWN');
    expect(JSON.stringify(other)).toContain("outside this project's own thread");
  });
});
