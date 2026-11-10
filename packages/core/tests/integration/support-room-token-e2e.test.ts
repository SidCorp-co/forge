import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/agent-sessions/session-credential.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/drizzle/migrations/0649_a_room_session_holds_one_token_across_its_turns.sql
//
// ISS-1202: a Rocket.Chat room's session acts every turn under its own fenced account, so it holds
// one token for its life (support-room-e2e shows the token of one turn acting between turns and in
// the next). That token still carries an expiry and is re-minted near it, and it is revoked when the
// session truly ends: archived, or let go by its room. Deleted, it is revoked by 0324's trigger.

const w = new SupportWorld();
let roomId = '';
let sessionId = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  const [room] = await w.rooms();
  roomId = String(room?.id);
  sessionId = String(room?.sessionId);
}, 120_000);

afterAll(() => w.stop());

describe("ISS-1202: a room session's one token ends with the session", () => {
  const liveTokens = () =>
    rows<{ id: string }>(sql`
      SELECT id FROM personal_access_tokens
       WHERE name = ${`turn:${sessionId}`} AND revoked_at IS NULL`);
  const turnSays = async (text: string) => {
    w.box.model = async (t, act) => {
      for (const m of t.messages)
        if (m.from !== 'forge') await act({ action: 'reply', thread: m.thread, text });
    };
    const id = await w.chat.say(w.chat.alice, `ping ${text}`);
    await w.untilLines((ls) => ls.some((l) => l.tmid === id && l.text === text));
    await expect
      .poll(async () => (await w.rooms())[0]?.sessionStatus, { timeout: 15_000 })
      .toBe('completed');
    return w.box.turns.at(-1) as Turn;
  };

  it('acts between two turns and in the next, which is handed the same token', async () => {
    await w.untilWarm();
    const turn = await turnSays('zero');
    // a pane that reconnects between two turns still reaches Forge [planted red: 401 UNAUTHENTICATED]
    const between = await w.box.tool(turn.token, { action: 'tools' });
    expect(JSON.stringify(between)).not.toMatch(/401|revoked|UNAUTH/i);
    expect(between.isError).toBe(false);
    let during: Record<string, unknown> = {};
    w.box.model = async (t, act) => {
      // the token the turn before was handed still acts in this one
      during = await w.box.tool(turn.token, { action: 'tools' });
      for (const m of t.messages)
        if (m.from !== 'forge') await act({ action: 'reply', thread: m.thread, text: 'next' });
    };
    const id = await w.chat.say(w.chat.alice, 'one more thing');
    await w.untilLines((ls) => ls.some((l) => l.tmid === id && l.text === 'next'));
    expect(w.box.turns.at(-1)?.token).toBe(turn.token);
    expect(during.isError).toBe(false);
    // one live token for the session, never one per turn
    expect(await liveTokens()).toHaveLength(1);
  });

  it('is re-minted near its expiry, and revoked once the session is archived or its room lets go of it', async () => {
    const before = await turnSays('one');
    const [held] = await liveTokens();
    expect(held).toBeDefined();
    // within the renewal margin of its expiry: the next turn is handed a fresh token, the old revoked
    await db.execute(sql`
      UPDATE personal_access_tokens SET expires_at = now() + interval '1 hour'
       WHERE id = ${held?.id}::uuid`);
    const renewed = await turnSays('two');
    expect(renewed.token).not.toBe(before.token);
    const fresh = await liveTokens();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.id).not.toBe(held?.id);
    // and it carries an expiry: no live token of the session is unbounded
    const [bounded] = await rows<{ hours: number }>(sql`
      SELECT extract(epoch FROM expires_at - now()) / 3600 AS hours
        FROM personal_access_tokens WHERE id = ${fresh[0]?.id}::uuid`);
    expect(Number(bounded?.hours)).toBeGreaterThan(2);
    expect(Number(bounded?.hours)).toBeLessThanOrEqual(12);

    // an archived session's turn ends with its token revoked
    await db.execute(sql`
      UPDATE agent_sessions SET metadata = metadata || '{"archived": true}'::jsonb
       WHERE id = ${sessionId}::uuid`);
    const archived = await turnSays('three');
    expect(await liveTokens()).toHaveLength(0);
    const spent = await w.box.tool(archived.token, { action: 'tools' });
    expect(JSON.stringify(spent)).toMatch(/UNAUTH/);
    await db.execute(sql`
      UPDATE agent_sessions SET metadata = metadata - 'archived' WHERE id = ${sessionId}::uuid`);

    // the room lets go of its session between turns, as a binding switched off does: revoked at once
    await turnSays('four');
    expect(await liveTokens()).toHaveLength(1);
    await db.execute(sql`UPDATE support_rooms SET session_id = NULL WHERE id = ${roomId}::uuid`);
    expect(await liveTokens()).toHaveLength(0);
  });
});
