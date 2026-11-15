/**
 * @direct-test-of packages/core/src/support/owner-owed-raise.ts
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { namespaceFromServerUrl } from '../../src/integrations/rocketchat/namespace.js';
import {
  handOwnerOwed,
  owedThreadOf,
  provideTechnicalRaise,
  type TechnicalRaise,
} from '../../src/support/owner-owed-raise.js';
import { roomById } from '../../src/support/store.js';
import { api, userToken } from '../helpers/api.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// ISS-1243 item 23 (owner, 2026-11-16): every decision his Needs you lists is handed to the
// project's agent once, and the agent puts it to him in the technical channel once, nowhere else.

const w = new AgentWorld();
let chat: StandInRocketChat;
let owner = '';
/** What the technical channel was handed: builder B's raise, stood in for here. */
const raised: { thread: string; need: string; text: string }[] = [];

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  owner = await userToken(w.ownerId);
  // alice, the owner the binding names, is the project owner's Forge account by a confirmed link
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespaceFromServerUrl(chat.serverUrl)}, ${OWNER_ID}, ${w.ownerId}, 'channel_email_match')`);
  const stand: TechnicalRaise = async (_room, input) => {
    raised.push(input);
    return { ok: true, value: { channel: 'dm', rid: 'dm-owner', messageId: `m${raised.length}` } };
  };
  provideTechnicalRaise(stand);
}, 120_000);

afterAll(() => w.stop());

type Out = Record<string, unknown>;

describe('ISS-1243 item 23: what waits on the owner, raised by the agent once per item', () => {
  it('hands each Needs-you decision to the agent once, and the agent raises it once in the technical channel', async () => {
    // a question a run parked on an issue, waiting on a person: the owner's Needs you lists it
    const issue = await createTestIssue(w.projectId, w.ownerId, 7801, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const asked = await api(owner, 'POST', '/api/questions', {
      issueId: issue.id,
      prompt: 'Ship the size-M print rule before the catalog sync?',
      options: [
        { id: 'yes', label: 'Yes', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
        { id: 'no', label: 'No', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
      ],
      recommendedOptionId: 'yes',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const thread = owedThreadOf(`question:${asked.body.id}`);

    const [roomRow] = await rows<{ id: string }>(sql`
      SELECT id FROM support_rooms WHERE project_id = ${w.projectId}::uuid AND kind = 'agent'
       ORDER BY created_at LIMIT 1`);
    const room = await roomById(String(roomRow?.id));
    if (!room) throw new Error('the agent room is gone');

    await w.settleWarm();
    const notes: { thread: string; text: string }[] = [];
    let raisedOut: Out = {};
    let again: Out = {};
    let elsewhere: Out = {};
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from !== 'forge' || m.thread !== thread) continue;
        notes.push({ thread: m.thread, text: m.text });
        raisedOut = await act({
          action: 'raise_owed',
          thread,
          text: 'Anh ơi, run hỏi: ship rule in size M trước khi sync catalog không? Em đề xuất: có.',
        });
        again = await act({ action: 'raise_owed', thread, text: 'Nhắc lại câu hỏi size M' });
        elsewhere = await act({
          action: 'raise_owed',
          thread: 'm-not-owed',
          text: 'Hỏi anh',
          rid: room.rid,
        });
      }
    };
    expect((await handOwnerOwed(room)).handed).toBeGreaterThanOrEqual(1);
    await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
    expect(notes[0]?.text).toContain('Ship the size-M print rule before the catalog sync?');
    expect(notes[0]?.text).toContain('Recommended: yes');
    await expect.poll(() => raisedOut, { timeout: 15_000 }).toMatchObject({ raised: true });
    expect(raised.filter((r) => r.thread === thread)).toEqual([
      expect.objectContaining({ need: 'approval' }),
    ]);
    await expect.poll(() => code(again), { timeout: 15_000 }).toBe('SUPPORT_OWED_ALREADY_RAISED');
    await expect.poll(() => code(elsewhere), { timeout: 15_000 }).toBe('SUPPORT_OWED_UNKNOWN');

    // a second sweep hands nothing it handed before
    expect((await handOwnerOwed(room)).handed).toBe(0);
    expect(chat.linesIn(chat.rid).some((l) => l.text.includes('size M'))).toBe(false);
  });
});
