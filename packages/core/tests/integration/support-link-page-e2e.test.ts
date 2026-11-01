import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// REQ-75 r5 under ISS-845 (owner, 2026-11-01: the agent is the only voice): a member's chat account
// is linked to their Forge user on the link page, never by a code typed in the room. The session asks
// with `link` and is handed the page to give the member; the member confirms it there, signed in,
// where the chat server's address for the account is matched against theirs; the session is then
// handed the fact. Core posts nothing, and no proof (a code, the address) reaches the session.

const w = new SupportWorld();
let ownerEmail = '';

beforeAll(async () => {
  await w.start();
  await w.bind();
  ownerEmail = String(
    (await rows<{ email: string }>(sql`SELECT email FROM users WHERE id = ${w.ownerId}::uuid`))[0]
      ?.email,
  );
  // the chat server reports alice's address as the owner's: alice is the owner's chat account
  (w.chat as StandInRocketChat).emails.set(w.chat.alice.userId, ownerEmail);
}, 120_000);

afterAll(() => w.stop());

type Out = Record<string, unknown>;

const linksOf = async (externalId: string) =>
  rows<{ user_id: string; confirmed_via: string }>(
    sql`SELECT user_id, confirmed_via FROM assistant_speaker_links
         WHERE source = 'rocketchat' AND external_id = ${externalId}`,
  );

const linesIn = async (thread: string) =>
  (await w.chat.botLines()).filter((l) => l.tmid === thread || l.id === thread);

const codesOf = (out: Out) =>
  ((out.error as { refusals?: { code: string }[] } | undefined)?.refusals ?? []).map((r) => r.code);

/** `who` writes `text`; the session asks to link `member` (the writer when absent). */
async function asked(
  who: typeof w.chat.alice,
  text: string,
  member?: string,
): Promise<{ thread: string; out: Out }> {
  await w.settleWarm();
  let out: Out | null = null;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge' || typeof m.from === 'string') continue;
      out = await act({ action: 'link', thread: m.thread, member: member ?? m.from.id });
    }
  };
  const thread = await w.chat.say(who, text);
  await expect.poll(() => out, { timeout: 10_000 }).not.toBeNull();
  return { thread, out: out as unknown as Out };
}

describe('ISS-845: a chat account is linked on the link page, the agent the only voice', () => {
  it('hands the session the page for an unlinked member, links them there, and tells the session', async () => {
    const turnsBefore = w.box.turns.length;
    const { thread, out } = await asked(w.chat.alice, 'Chuyển ISS-1 sang in_progress giúp mình');
    expect(out, JSON.stringify(out)).toMatchObject({ linked: false });
    const url = new URL(String(out.url));
    expect(url.pathname).toBe('/link-chat');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: w.projectId,
      source: 'rocketchat',
      externalId: w.chat.alice.userId,
    });
    expect(await linksOf(w.chat.alice.userId)).toEqual([]);

    // the member confirms on the page, signed in to Forge as themselves
    await w.settleWarm();
    const notes: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from === 'forge') notes.push(m.text);
    };
    const confirmed = await api(w.owner, 'POST', `/api/projects/${w.projectId}/speaker-links`, {
      source: 'rocketchat',
      externalId: w.chat.alice.userId,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(await linksOf(w.chat.alice.userId)).toEqual([
      { user_id: w.ownerId, confirmed_via: 'channel_email_match' },
    ]);
    await expect
      .poll(() => notes.some((n) => n.startsWith('@alice is now linked')), { timeout: 10_000 })
      .toBe(true);

    // asked again, the session reads the member as linked
    const again = await asked(w.chat.alice, 'Giờ được chưa?');
    expect(again.out).toMatchObject({ linked: true });

    // nothing was posted, and no proof reached the session
    expect(await linesIn(thread)).toEqual([]);
    expect(await linesIn(again.thread)).toEqual([]);
    expect(w.box.turns.slice(turnsBefore).some((t) => t.text.includes(ownerEmail))).toBe(false);
  });

  it('refuses, by name, a member who has not written in the thread', async () => {
    const { thread, out } = await asked(w.chat.bob, 'Link giúp alice', w.chat.alice.userId);
    expect(codesOf(out), JSON.stringify(out)).toEqual(['SUPPORT_ASKER_NOT_IN_THREAD']);
    expect(await linesIn(thread)).toEqual([]);
  });

  it('takes a typed `link <code>` as an ordinary message for the session, and posts nothing', async () => {
    await w.settleWarm();
    const handed: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') handed.push(m.text);
    };
    const said = await w.chat.say(w.chat.bob, 'link K7QX2MAB');
    await expect.poll(() => handed, { timeout: 10_000 }).toContain('link K7QX2MAB');
    expect(await linesIn(said)).toEqual([]);
    expect(await linksOf(w.chat.bob.userId)).toEqual([]);
  });
});
