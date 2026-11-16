import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';

// @direct-test-of packages/core/src/support/asker-read.ts
// @direct-test-of packages/core/src/support/thread-context.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/support/master-ask-routes.ts
// @direct-test-of packages/contracts/src/support-channel.ts
// @direct-test-of packages/core/src/support/room-guide.ts
// @direct-test-of packages/core/src/guides/room-agent-guide.ts
//
// ISS-1250 (epod thread of the shared operations room, 16/11): the epod master posted at 02:18 that
// the new errors read in Vietnamese; at 02:21 the organization's owner ruled "language per the
// setting, English by default", and the room agent, knowing nothing of him nor of that post, read it
// as one about its own settings and sent him to them. `asker` is the door the agent reads both
// through before it acts: it names him as the organization's owner, hands the post the ruling
// answers, and writes nothing (owner 2026-11-16: tools and teaching, never a forced fill).

const w = new AgentWorld();

beforeAll(async () => {
  await w.openAgent();
  // alice's chat account is the Forge account that owns the project's organization
  const namespace = new URL(w.stand.serverUrl).host;
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespace}, ${w.stand.alice.userId}, ${w.stand.alice.username}, ${w.ownerId}, 'channel_email_match')`);
}, 120_000);

afterAll(() => w.stop());

type Facts = Record<string, unknown> & {
  thread: { recent: { from: string; text: string }[]; theirEarlier: unknown[]; openAsks: string[] };
};

const POST = 'ePOD v1.4.2 is live: the new CLI and theme errors read in Vietnamese.';
const RULING = '@babo language per the setting, English by default';

describe('the agent reads who is asking and the thread around a ruling', () => {
  it('names the organization owner, hands the post his ruling answers, and writes nothing', async () => {
    const opened = await w.hear(
      () => w.stand.say(w.stand.alice, 'is the ePOD release out?'),
      async (_t, act, message) => {
        await act({ action: 'silent', thread: message().thread, reason: 'the master answers it' });
      },
    );
    const post = await api(w.owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, {
      text: POST,
      rid: w.stand.rid,
      thread: opened.id,
    });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    const before = await rows<{ roles: string[]; state: string }>(
      sql`SELECT roles, state FROM support_channel_members WHERE username = 'alice'`,
    );

    let facts = {} as Facts;
    let wrong: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.alice, RULING, opened.id),
      async (_t, act, message) => {
        const { thread, message: id } = message();
        facts = (await act({ action: 'asker', thread, message: id })) as Facts;
        wrong = await act({ action: 'asker', thread, message: opened.id.replace(/.$/, 'x') });
        await act({ action: 'silent', thread, message: id, reason: 'asked the master' });
      },
    );
    expect(facts.isError, JSON.stringify(facts)).toBe(false);
    expect(facts).toMatchObject({
      org: 'owner',
      reader: 'owner',
      member: { roles: ['user', 'product'], confirmed: true },
      accountRoles: ['product', 'technical'],
    });
    expect(facts.thread.recent.map((l) => l.text)).toEqual(['is the ePOD release out?', POST]);
    expect(facts.thread.recent.at(-1)?.from).toBe('bot');
    expect(JSON.stringify(facts.thread)).not.toContain('English by default');
    expect(code(wrong)).toBe('OPS_ASKER_MESSAGE_UNKNOWN');
    // a read: the record stands as the person who set it left it
    expect(
      await rows<{ roles: string[]; state: string }>(
        sql`SELECT roles, state FROM support_channel_members WHERE username = 'alice'`,
      ),
    ).toEqual(before);
  });

  it('says why Forge cannot name a writer with no account, and reads the record for them', async () => {
    let facts = {} as Facts;
    await w.hear(
      () => w.stand.say(w.stand.bob, 'is the shop open today?'),
      async (_t, act, message) => {
        const { thread, message: id } = message();
        facts = (await act({ action: 'asker', thread, message: id })) as Facts;
        await act({ action: 'silent', thread, message: id, reason: 'read only' });
      },
    );
    expect(facts.isError, JSON.stringify(facts)).toBe(false);
    expect(facts).toMatchObject({
      forge: { account: null },
      org: null,
      member: { roles: ['user'], confirmed: true },
      reader: 'plain',
    });
    expect(JSON.stringify(facts.forge)).toContain('unnamed');
  });

  it('teaches the agent to read it before an instruction', () => {
    expect(w.brief()).toContain('support.asker { thread, message }');
    expect(w.brief()).toContain('support.guide {}');
  });
});

// ISS-1251 (owner 2026-11-16): the brief is a map, and the detail behind it is the room agent's
// guide, which the organization's knowledge entry stands in for, so teaching changes with no deploy.
describe('the room agent reads its guide: its organization’s where it keeps one, else Forge’s', () => {
  async function guide() {
    let out: Record<string, unknown> = {};
    await w.hear(
      () => w.stand.say(w.stand.bob, 'how do refunds work?'),
      async (_t, act, message) => {
        out = await act({ action: 'guide' });
        await act({ action: 'silent', thread: message().thread, reason: 'read the guide' });
      },
    );
    return out;
  }

  it('hands the shipped guide, then the organization’s own once it keeps one', async () => {
    const shipped = await guide();
    expect(shipped.isError, JSON.stringify(shipped)).toBe(false);
    expect(shipped).toMatchObject({ from: 'forge', slug: 'room-agent' });
    expect(String(shipped.body)).toContain('### Deciding each message');
    await db.execute(sql`
      INSERT INTO org_knowledge_entries (org_id, slug, title, body, injection)
      SELECT org_id, 'room-agent-guide', 'Room agent guide', 'When the owner rules, hand it on.', 'on_demand'
        FROM projects WHERE id = ${w.projectId}::uuid`);
    expect(await guide()).toMatchObject({
      from: 'org',
      slug: 'room-agent-guide',
      body: 'When the owner rules, hand it on.',
    });
  });
});
