import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { BRIEF_CHANGED_LEAD, BRIEF_TOLD_KEY } from '../../src/support/brief-told.js';
import { rows } from '../helpers/factories.js';
import { ChannelWorld } from '../helpers/support-channel.js';

// ISS-1251 c8, c11: a room session stays resident for days, and the brief it follows is the one it
// was told. Forge-Communicate's answered the owner on 17/11 from a session started on 04/11 and last
// briefed on 15/11, before the lines that read who wrote a message, keep the member record and raise
// a missing grant in the technical channel: its record stayed at 0 members and it told the owner
// what its role could not do. A resident session told another brief than this build renders is told
// it again, whole, on its next turn, and once only; what it was told is kept on its row.
// @direct-test-of packages/core/src/support/brief-told.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/warm.ts

const w = new ChannelWorld();

beforeAll(() => w.open(), 120_000);

afterAll(() => w.stop());

const sessionId = async () => {
  const [room] = await rows<{ session_id: string }>(
    sql`SELECT session_id FROM support_rooms WHERE id = ${w.roomId}::uuid`,
  );
  return String(room?.session_id);
};

const told = async () => {
  const [row] = await rows<{ told: string | null }>(
    sql`SELECT metadata->>${BRIEF_TOLD_KEY} AS told FROM agent_sessions WHERE id = ${await sessionId()}::uuid`,
  );
  return row?.told ?? null;
};

describe('a resident room session follows the brief this build renders', () => {
  it('keeps what a session was told on its row, and tells a warm session nothing it holds', async () => {
    await w.ask(w.chat.bob, 'first question of the day', async () => undefined);
    const key = await told();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const warm = await w.ask(w.chat.bob, 'a second question', async () => undefined);
    expect(warm.turn.text).not.toContain(BRIEF_CHANGED_LEAD);
    expect(await told()).toBe(key);
  });

  it('tells a session briefed on an older brief the whole brief again, its member line among it, once', async () => {
    const key = await told();
    // planted: the session holds the brief another build rendered, as Forge-Communicate's held 15/11's
    await db.execute(sql`UPDATE agent_sessions
         SET metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ [BRIEF_TOLD_KEY]: 'told-on-15-11' })}::jsonb
       WHERE id = ${await sessionId()}::uuid`);
    const stale = await w.ask(w.chat.bob, 'who keeps the members here', async () => undefined);
    expect(stale.turn.text).toContain(BRIEF_CHANGED_LEAD);
    for (const line of [
      'support.asker { thread, message }',
      'support.member { member, roles, message }',
      'support.technical { thread, need, text }',
    ]) {
      expect(stale.turn.text, line).toContain(line);
    }
    expect(await told()).toBe(key);
    const after = await w.ask(w.chat.bob, 'and one more thing', async () => undefined);
    expect(after.turn.text).not.toContain(BRIEF_CHANGED_LEAD);
  });
});
