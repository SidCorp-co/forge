import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { createTestProject, rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// REQ-75 r5: a member's chat account is linked to their Forge user without the chat server's
// admin-only address read. The user, signed in, mints a one-time code; written as `link <code>` in
// a room bound to the project from the chat account itself, it confirms the link, since the server
// signs who wrote it. The code is spent once, lapses, belongs to one project, and never reaches the
// room's session. The world is support-room-e2e's.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

const mint = async (token = w.owner, projectId = w.projectId, source = 'rocketchat') =>
  api(token, 'POST', `/api/projects/${projectId}/speaker-links/codes`, { source });

const linksOf = async (externalId: string) =>
  rows<{ user_id: string; confirmed_via: string; external_label: string | null }>(
    sql`SELECT user_id, confirmed_via, external_label FROM assistant_speaker_links
         WHERE source = 'rocketchat' AND external_id = ${externalId}`,
  );

describe('REQ-75 r5: a chat account is linked by a code its Forge user minted', () => {
  it('links the account that writes the code to the user who minted it, once, without the session seeing it', async () => {
    const minted = await mint();
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const code = String(minted.body.code);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(minted.body.write).toBe(`link ${code}`);
    await w.settleWarm();
    const turnsBefore = w.box.turns.length;

    const said = await w.chat.say(w.chat.alice, `link ${code}`);
    await w.untilLines((ls) =>
      ls.some(
        (l) => l.tmid === said && l.text.startsWith('@alice is now linked to the Forge account'),
      ),
    );
    expect(await linksOf(w.chat.alice.userId)).toEqual([
      { user_id: w.ownerId, confirmed_via: 'chat_code', external_label: 'alice' },
    ]);
    // the code is neither handed to the session nor kept in the record
    expect(w.box.turns.slice(turnsBefore).some((t) => t.text.includes(code))).toBe(false);
    const kept = await rows<{ n: number }>(
      sql`SELECT (SELECT count(*) FROM conversation_messages WHERE content LIKE ${`%${code}%`})
               + (SELECT count(*) FROM support_actions
                   WHERE input::text LIKE ${`%${code}%`} OR output::text LIKE ${`%${code}%`}) AS n`,
    );
    expect(Number(kept[0]?.n)).toBe(0);

    // a member who read it in the room and writes it again links nothing
    const replay = await w.chat.say(w.chat.bob, `link ${code}`);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === replay && l.text.startsWith('No link code waits under that code')),
    );
    expect(await linksOf(w.chat.bob.userId)).toEqual([]);
  });

  it('links nothing with a lapsed code or one made for another project', async () => {
    const lapsed = String((await mint()).body.code);
    await db.execute(sql`UPDATE speaker_link_codes SET expires_at = now() - interval '1 minute'
                          WHERE used_at IS NULL`);
    const one = await w.chat.say(w.chat.bob, `link ${lapsed}`);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === one && l.text.startsWith('No link code waits under that code')),
    );
    const other = (await createTestProject(w.ownerId)).id;
    const { addProjectMember } = await import('../helpers/factories.js');
    await addProjectMember(other, w.ownerId, 'owner');
    const elsewhere = await mint(w.owner, other);
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);
    const two = await w.chat.say(w.chat.bob, `link ${String(elsewhere.body.code)}`);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === two && l.text.startsWith('No link code waits under that code')),
    );
    expect(await linksOf(w.chat.bob.userId)).toEqual([]);
  });

  it('mints only for a member of the project, and only for a channel Forge knows', async () => {
    expect((await mint(w.stranger)).status).toBe(403);
    const unknown = await mint(w.owner, w.projectId, 'carrier-pigeon');
    expect(JSON.stringify(unknown.body)).toContain('SPEAKER_SOURCE_UNKNOWN');
  });
});
