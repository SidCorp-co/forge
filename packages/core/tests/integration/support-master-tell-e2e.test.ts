/**
 * @direct-test-of packages/core/src/support/master-tell.ts
 * @direct-test-of packages/core/src/support/master-ask-routes.ts
 * @direct-test-of packages/core/src/support/screen.ts
 * @direct-test-of packages/core/src/support/grants.ts
 * @direct-test-of packages/core/src/support/turn-retry.ts
 * @direct-test-of packages/contracts/src/support-master-ask.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld } from '../helpers/support-world.js';
import { inUntrustedFrame } from '../helpers/untrusted-frame.js';

// ISS-1466 (FB-866): a master's English report, with commit shas, issue keys and tool words, reached a
// users' room as the bot's own post. Core's screen barred codes only where the binding's readers read
// as users, so a support room whose binding says `readers: team` let them through. A master's post is
// never the team's own report in a room the product's people may sit in, and what a master wants told
// there goes to the room's bot as facts, which the bot says in its own words.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const w = new SupportWorld();
let chat: StandInRocketChat;

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  // a support room whose binding names readers: team, the shape the owner's report came from
  await w.bind({ product: 'HR desk', readers: 'team', grants: { abilities: ['file_items'] } });
}, 120_000);

afterAll(() => w.stop());

const post = (body: unknown) =>
  api(w.owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const tell = (body: unknown, token = w.owner) =>
  api(token, 'POST', `/api/projects/${w.projectId}/support/master-tells`, body);

/** `alice` writes `text`; the session takes it and its turn is left to say nothing. */
async function asked(text: string): Promise<string> {
  await w.settleWarm();
  const taken: string[] = [];
  w.box.model = async (turn) => {
    for (const m of turn.messages) if (typeof m.from !== 'string') taken.push(m.thread);
  };
  const id = await chat.say(chat.alice, text);
  await expect.poll(() => taken.length, { timeout: 15_000 }).toBeGreaterThan(0);
  return id;
}

describe("ISS-1466: a master's post in a support room carries no code, whatever its readers say", () => {
  it('refuses a sha and an issue key by name in a readers: team support room, naming the door that tells the bot', async () => {
    const thread = await asked('Bản 0.33.0 còn lỗi in phiếu');
    const res = await post({
      text: 'Fixed in 3971924c4 under ISS-1466; judged on staging.',
      thread,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalCodes(res.body as Record<string, unknown>)).toEqual(['SUPPORT_INTERNAL_CODE']);
    const detail = JSON.stringify(res.body);
    expect(detail).toContain('whatever its binding');
    expect(detail).toContain('commit sha \\"3971924c4');
    expect(detail).toContain('master-tells');
    expect(chat.linesIn(chat.rid).filter((l) => l.tmid === thread)).toEqual([]);
    // plain words still go
    const plain = await post({ text: 'Bản sửa đã lên, bạn thử lại giúp nhé.', thread });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
  });
});

describe("ISS-1466: a master hands a room's bot facts for a thread", () => {
  it("reaches the room agent's session in that thread, framed as data, posts nothing, and is handed once", async () => {
    const thread = await asked('Phiếu in vẫn lỗi, khi nào xong?');
    await w.settleWarm();
    const notes: { thread: string; text: string }[] = [];
    w.box.idleTurnsAct = false;
    w.box.model = async (turn) => {
      for (const m of turn.messages)
        if (m.from === 'forge') notes.push({ thread: m.thread, text: m.text });
    };
    try {
      const facts =
        'ISS-1466 landed at 3971924c4; judged live on staging; print fix is on production.';
      const res = await tell({ thread, facts });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ told: true, rid: chat.rid, thread });
      await expect.poll(() => notes.length, { timeout: 15_000 }).toBe(1);
      const note = notes[0];
      expect(note?.thread).toBe(thread);
      expect(inUntrustedFrame(note?.text ?? '', facts)).toBe(true);
      // the teaching that makes the bot restate it, outside the frame
      expect(note?.text).toContain('in your own words and in the language they write');
      expect(note?.text).toContain('no issue key, commit sha, branch name or release tag');
      expect(note?.text).toContain('never posted as they are');
      expect(chat.linesIn(chat.rid).filter((l) => l.tmid === thread)).toEqual([]);
      // a turn that completes with no words does not have it handed again (isMasterAnswer)
      await w.settleWarm();
      await new Promise((r) => setTimeout(r, 7_000));
      await w.settleWarm();
      expect(notes).toHaveLength(1);
    } finally {
      w.box.idleTurnsAct = true;
    }
  }, 120_000);

  it('refuses by name a thread no member wrote in, a room this project does not bind, and a caller who cannot write', async () => {
    const unknown = await tell({ thread: 'AAAAAAAAAAAAAAAAA', facts: 'The fix is live.' });
    expect(refusalCodes(unknown.body as Record<string, unknown>)).toEqual([
      'SUPPORT_THREAD_UNKNOWN',
    ]);
    expect(JSON.stringify(unknown.body)).toContain('Nothing was handed on');
    const thread = await asked('Một câu hỏi khác');
    const room = await tell({ thread, facts: 'The fix is live.', rid: `nope-${randomUUID()}` });
    expect(refusalCodes(room.body as Record<string, unknown>)).toEqual(['SUPPORT_ROOM_UNKNOWN']);
    expect((await tell({ thread, facts: 'The fix is live.' }, w.stranger)).status).toBe(403);
    const bad = await tell({ thread, facts: 'ok', text: 'nope' });
    expect(bad.status).toBe(400);
  });
});
