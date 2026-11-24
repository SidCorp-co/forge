import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// ISS-1455 (FB-854): binding.write from the owner's room. Its item names a binding the project holds
// or is "new"; anything else is refused by name, never as a database error, and "new" makes a
// binding through the binding door's own create rules.
// @direct-test-of packages/core/src/support/owner-forge-act.ts
// @direct-test-of packages/core/src/support/owner-binding-act.ts

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let chuong = '';
let viewer = '';

/** `who` writes `text`; the session asks for `args` as the owner's act, citing `cite(message)`. */
async function askBy(
  who: typeof chat.alice,
  text: string,
  args: Record<string, unknown>,
  cite: (heard: { thread: string; message: string }) => { thread: string; message: string } = (h) =>
    h,
) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_forge_act',
        ...cite({ thread: String(message().thread), message: String(message().message) }),
        project: slug,
        ...args,
      });
    },
  );
  return { id: heard.id, thread: heard.message.thread, out };
}

const bindingsOf = async (projectId: string) =>
  rows<{ id: string; provider: string; revision: number }>(
    sql`SELECT id, provider, revision FROM integration_bindings WHERE project_id = ${projectId} AND provider = 'agent'`,
  );

describe("ISS-1455: binding.write from the owner's room names its item", () => {
  // ISS-1455 (FB-854): binding.write's item names a binding the project holds, or "new" makes one
  it('refuses a binding.write item that is no binding of the project, by name, with no database error', async () => {
    const foreign = randomUUID();
    const mine = randomUUID();
    const connection = randomUUID();
    await db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connection}, 'user', ${chuong}, 'agent', true)`);
    const document = (id: string) => ({
      $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
      version: 1,
      id,
      role: 'service',
      connection,
      target: { provider: 'agent' },
    });
    // the exact call the agent made: a provider name where an id belongs
    for (const item of ['sentry', mine, 'agent']) {
      const out = await askBy(chat.alice, 'nối Sentry cho project', {
        act: 'binding.write',
        item,
        baseRevision: null,
        document: document(mine),
      });
      expect(code(out.out), JSON.stringify(out.out)).toBe('SUPPORT_FORGE_ACT_SHAPE');
      expect(JSON.stringify(out.out)).toContain('/item');
      expect(JSON.stringify(out.out)).toContain('item \\"new\\"');
      expect(JSON.stringify(out.out)).not.toMatch(/invalid input syntax|uuid|SQL|relation/);
    }
    // a binding of another project is no binding of this one, and the refusal does not say whose
    const other = await createTestProject(chuong);
    await db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
      VALUES (${foreign}, ${connection}, ${other.id}, 'agent', 'service', true, '{}'::jsonb)`);
    const theirs = await askBy(chat.alice, 'sửa binding đó', {
      act: 'binding.write',
      item: foreign,
      baseRevision: 1,
      document: document(foreign),
    });
    expect(code(theirs.out), JSON.stringify(theirs.out)).toBe('SUPPORT_FORGE_ACT_SHAPE');
    expect(JSON.stringify(theirs.out)).toContain('item \\"new\\"');
    expect(await bindingsOf(w.projectId)).toEqual([]);
    // "new" with a revision is a shape refusal, nothing written
    const based = await askBy(chat.alice, 'tạo binding', {
      act: 'binding.write',
      item: 'new',
      baseRevision: 3,
      document: document(mine),
    });
    expect(code(based.out), JSON.stringify(based.out)).toBe('SUPPORT_FORGE_ACT_SHAPE');
    expect(JSON.stringify(based.out)).toContain('/baseRevision');
  });

  it("makes the project's first binding as him with item new, through the binding door's own rules", async () => {
    const [conn] = await rows<{ id: string }>(
      sql`SELECT id FROM integration_connections WHERE owner_id = ${chuong} AND provider = 'agent' LIMIT 1`,
    );
    const connection = String(conn?.id);
    const document = {
      $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
      version: 1,
      role: 'service',
      connection,
      target: { provider: 'agent' },
    };
    // a viewer's message, or a provider no connection covers, the door refuses by its own name
    const bobs = await askBy(chat.bob, 'nối agent', {
      act: 'binding.write',
      item: 'new',
      baseRevision: null,
      document,
    });
    expect(code(bobs.out), JSON.stringify(bobs.out)).toBe('SUPPORT_FORGE_ACT_NOT_THE_OWNER');
    const mismatch = await askBy(chat.alice, 'nối sentry', {
      act: 'binding.write',
      item: 'new',
      baseRevision: null,
      document: { ...document, target: { provider: 'sentry' } },
    });
    expect(code(mismatch.out), JSON.stringify(mismatch.out)).toBe('CONNECTION_PROVIDER_MISMATCH');
    expect(await bindingsOf(w.projectId)).toEqual([]);
    const made = await askBy(chat.alice, 'nối agent cho project', {
      act: 'binding.write',
      item: 'new',
      baseRevision: null,
      document,
    });
    expect(code(made.out), JSON.stringify(made.out)).toBeUndefined();
    const held = await bindingsOf(w.projectId);
    expect(held.map((b) => b.provider)).toEqual(['agent']);
    expect(JSON.stringify(made.out)).toContain(String(held[0]?.id));
    // and the id it was given now names it: the same act changes it at the revision read
    const again = await askBy(chat.alice, 'tắt binding đó', {
      act: 'binding.write',
      item: String(held[0]?.id),
      baseRevision: Number(held[0]?.revision),
      document: { ...document, id: held[0]?.id, active: false },
    });
    expect(code(again.out), JSON.stringify(again.out)).toBeUndefined();
  });
});

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [project] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}`,
  );
  slug = String(project?.slug);
  // alice, the owner the binding names, is chuong in Forge, an admin; bob is a viewer
  chuong = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, chuong, 'admin');
  viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, viewer, 'viewer');
  const namespace = new URL(chat.serverUrl).host;
  for (const [member, userId] of [
    [chat.alice, chuong],
    [chat.bob, viewer],
  ] as const) {
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${member.userId}, ${member.username}, ${userId}, 'channel_email_match')`);
  }
}, 120_000);

afterAll(async () => {
  await w.stop();
});
