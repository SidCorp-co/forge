import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/service.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/turn-retry.ts
// @direct-test-of packages/core/src/support/prompt.ts
// @direct-test-of packages/core/src/support/turn-of-act.ts
// @direct-test-of packages/core/src/support/turn-record.ts
// @direct-test-of packages/core/src/agent-sessions/turn-events.ts
// @direct-test-of packages/core/src/support/room-brief.ts
//
// ISS-942: a room agent's silence wrote nothing and a reply carried no reason, so a wrong silence
// or a wrong answer could not be found and the room's policy tuned. support.silent posts nothing and
// records its reason on the room and the thread; a reply keeps its one-line why.
//
// ISS-1007 and ISS-764 (a): a turn that completed with nothing said for a message it was handed
// (a 1-3 s exit, a turn declared done while the process still worked) read as answered, so the
// person waited with no failure and no retry recorded. It is handed again until its tries run out,
// then recorded on its thread as unanswered, by name. ISS-764 (d): a thread handed several messages
// in one turn says so on each, so the one result covers them all.

const w = new SupportWorld();

beforeAll(async () => {
  await w.start();
  await w.bind();
}, 120_000);

afterAll(() => w.stop());

const roomId = async () => String((await w.rooms())[0]?.id);

describe('ISS-942: a silence and a reply each keep their reason on the room', () => {
  it('records a silence with its reason, posting nothing, and a reply with its why', async () => {
    await w.settleWarm();
    const done: Record<string, unknown>[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        done.push(
          m.text.includes('thanks')
            ? await act({
                action: 'silent',
                thread: m.thread,
                message: m.message,
                reason: 'thanks, nothing asked',
              })
            : await act({
                action: 'reply',
                thread: m.thread,
                text: 'The export runs nightly at two.',
                why: 'asked when the export runs',
              }),
        );
      }
    };
    const thanks = await w.chat.say(w.chat.alice, 'thanks all');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(1);
    const asked = await w.chat.say(w.chat.alice, 'When does the export run?');
    await expect.poll(() => done.length, { timeout: 15_000 }).toBe(2);
    expect(
      done.every((d) => d.isError === false),
      JSON.stringify(done),
    ).toBe(true);
    expect(await w.linesIn(thanks)).toEqual([]);
    const actions = await w.actions(await roomId());
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'silent',
        thread: thanks,
        input: { reason: 'thanks, nothing asked', message: thanks },
      }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'reply',
        thread: asked,
        input: expect.objectContaining({ why: 'asked when the export runs' }),
      }),
    );
    // the silence is a line on the thread's conversation too
    const [line] = await rows<{ content: string }>(sql`
      SELECT m.content FROM conversation_messages m
       WHERE m.role = 'system' AND m.content = 'stayed silent: thanks, nothing asked'`);
    expect(line?.content).toBe('stayed silent: thanks, nothing asked');
  });
});

describe('ISS-1007: a completed turn that said nothing for a message is not read as an answer', () => {
  it('hands the message again, then records it unanswered by name once its tries run out', async () => {
    await w.settleWarm();
    const handed: string[] = [];
    // the 1-3 s exits of 2026-11-01: the turn completes and nothing is said for the message
    w.box.idleTurnsAct = false;
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') handed.push(m.message ?? '');
    };
    const id = await w.chat.say(w.chat.alice, 'Can you research the channel feature?');
    await expect.poll(() => handed.length, { timeout: 60_000, interval: 200 }).toBe(3);
    const unanswered = () =>
      rows<{ output: { messages: string[]; cause: string } }>(sql`
        SELECT output FROM support_actions
         WHERE thread = ${id} AND kind = 'refused' AND tool = 'turn_unanswered'`);
    await expect.poll(async () => (await unanswered()).length, { timeout: 15_000 }).toBe(1);
    expect((await unanswered())[0]?.output.cause).toContain('support.silent');
    const retries = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions
       WHERE thread = ${id} AND kind = 'refused' AND tool = 'turn_retry'`);
    expect(retries[0]?.n).toBe(2);
    // no line tells the room it broke: the session ran and chose to say nothing
    expect(await w.linesIn(id)).toEqual([]);
    await w.settleWarm();
    expect(handed).toEqual([id, id, id]);
    w.box.idleTurnsAct = true;
  });

  it('hands nothing again from a turn that acted, though it posted nothing for the message', async () => {
    await w.settleWarm();
    const handed: string[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        handed.push(m.message ?? '');
        await act({ action: 'thread', thread: m.thread });
      }
    };
    const id = await w.chat.say(w.chat.alice, 'Morning all');
    await expect.poll(() => handed.length, { timeout: 15_000 }).toBe(1);
    await w.settleWarm();
    expect(handed).toEqual([id]);
    const retries = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_actions WHERE thread = ${id} AND tool = 'turn_retry'`);
    expect(retries[0]?.n).toBe(0);
  });
});

describe('ISS-1029: a room action names its turn, and the turn keeps what the session read', () => {
  it('links a reply to its session and turn, and reads that turn scrubbed for the project', async () => {
    await w.settleWarm();
    let seq = 1_000_000;
    const line = (l: Record<string, unknown>) => ({
      seq: seq++,
      kind: 'stdout',
      data: { line: l },
    });
    let replied: Record<string, unknown> | null = null;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.from !== 'forge');
      if (!m) return;
      // what the session read before it named a cause, as the runner posts its stream
      const posted = await fetch(`${w.core.base}/api/agent-sessions/${turn.sessionId}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${w.box.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            line({
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', name: 'Bash', input: { command: 'grep PO-1453 app.log' } },
                ],
              },
            }),
            line({
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    content: `send failed for PO-1453 bot=${w.chat.bot.authToken}`,
                  },
                ],
              },
            }),
          ],
        }),
      });
      expect(posted.status, await posted.clone().text()).toBe(200);
      replied = await act({
        action: 'reply',
        thread: m.thread,
        text: 'PO-1453 failed to send; the supplier refused it.',
        why: 'asked why PO-1453 did not go',
      });
    };
    const asked = await w.chat.say(w.chat.alice, 'Why did PO-1453 not go out?');
    await expect.poll(() => replied, { timeout: 15_000 }).not.toBeNull();
    const roomOf = await roomId();
    const reply = (await w.actions(roomOf)).find((a) => a.kind === 'reply' && a.thread === asked);
    // [ACTION_NAMES_NO_TURN] before the fix: no action said which session or turn took it
    const turn = reply?.turn as { sessionId: string; id: string } | null | undefined;
    expect(turn, JSON.stringify(reply)).toMatchObject({ sessionId: expect.any(String) });
    const path = `/api/projects/${w.projectId}/support/rooms/${roomOf}/turns/${turn?.id}`;
    const got = await api(w.owner, 'GET', path);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const record = got.body.turn as { sessionId: string; steps: Record<string, unknown>[] };
    expect(record.sessionId).toBe(turn?.sessionId);
    expect(record.steps).toContainEqual({
      kind: 'called',
      tool: 'Bash',
      input: JSON.stringify({ command: 'grep PO-1453 app.log' }),
    });
    const answer = record.steps.find((s) => s.kind === 'answered');
    expect(String(answer?.text)).toContain('send failed for PO-1453');
    expect(JSON.stringify(record)).not.toContain(w.chat.bot.authToken);
    // only the project's people read it, and a turn no action names is refused by name
    expect((await api(w.stranger, 'GET', path)).status).toBeGreaterThanOrEqual(403);
    const unknown = await api(
      w.owner,
      'GET',
      `/api/projects/${w.projectId}/support/rooms/${roomOf}/turns/00000000-0000-4000-8000-000000000000`,
    );
    expect(unknown.status).toBe(404);
    expect(JSON.stringify(unknown.body)).toContain('SUPPORT_TURN_UNKNOWN');
  });
});

// ISS-1118 (REQ-92): the binding's owner project read neither a room's turns by thread nor the brief,
// grants and routes its agent works under, so "where did the agent read stale state" had no answer
describe('ISS-1118: a binding owner reads its room agent\'s turns, and the brief, grants and routes in force', () => {
  it('lists a room\'s turns by thread and reads one: its trigger, calls, results and reply', async () => {
    await w.settleWarm();
    let seq = 2_000_000;
    let replied: Record<string, unknown> | null = null;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.from !== 'forge');
      if (!m) return;
      const line = (l: Record<string, unknown>) => ({ seq: seq++, kind: 'stdout', data: { line: l } });
      // a read of another project's record through a grant, as the runner posts the session's stream
      const posted = await fetch(`${w.core.base}/api/agent-sessions/${turn.sessionId}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${w.box.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [
            line({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', name: 'support.releases', input: { project: 'adminhub' } }] },
            }),
            line({
              type: 'user',
              message: { content: [{ type: 'tool_result', content: 'adminhub v1.31.1: awaiting release' }] },
            }),
          ],
        }),
      });
      expect(posted.status, await posted.clone().text()).toBe(200);
      replied = await act({ action: 'reply', thread: m.thread, text: 'v1.31.1 is not live yet.', why: 'asked if it shipped' });
    };
    const asked = await w.chat.say(w.chat.alice, 'Is v1.31.1 live?');
    await expect.poll(() => replied, { timeout: 15_000 }).not.toBeNull();
    const room = await roomId();
    const base = `/api/projects/${w.projectId}/support/rooms/${room}/turns`;
    // [ROOM_TURNS_UNLISTED] before the fix: no route listed a room's turns, by thread or at all
    const listed = await api(w.owner, 'GET', `${base}?thread=${encodeURIComponent(asked)}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const turns = listed.body.turns as Record<string, unknown>[];
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ threads: [asked], replied: true, refused: false });
    const read = await api(w.owner, 'GET', `${base}/${String(turns[0]?.id)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const turn = read.body.turn as Record<string, unknown>;
    // [TURN_TRIGGER_UNREAD] before the fix: the record held the stream alone, not what started it or what it posted
    expect(turn.trigger).toEqual([expect.objectContaining({ thread: asked, text: 'Is v1.31.1 live?' })]);
    expect(turn.acts).toContainEqual(
      expect.objectContaining({ kind: 'reply', thread: asked, input: expect.objectContaining({ text: 'v1.31.1 is not live yet.' }) }),
    );
    expect(turn.steps).toContainEqual({ kind: 'answered', text: 'adminhub v1.31.1: awaiting release' });
    // the fence: a caller outside the binding's owner project is refused, by name
    const outside = await api(w.stranger, 'GET', base);
    expect(outside.status).toBe(403);
    expect(outside.body).toMatchObject({ code: 'FORBIDDEN', detail: expect.stringContaining('project.read') });
  });

  it('reads the room\'s brief, grants and routes in force with when each last changed, and no secret', async () => {
    const room = await roomId();
    const path = `/api/projects/${w.projectId}/support/rooms/${room}/brief`;
    // [BINDING_BRIEF_UNREAD] before the fix: no route read a room's brief and grants as its agent holds them
    const got = await api(w.owner, 'GET', path);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const brief = got.body.brief as Record<string, unknown>;
    expect(brief.binding).toMatchObject({ revision: expect.any(Number), changedAt: expect.any(String) });
    expect(brief.brief).toMatchObject({ product: 'Catalog, the shop back office' });
    expect(brief.grants).toMatchObject({ abilities: ['read_checkout', 'file_items'] });
    expect(brief.routes).toEqual(expect.any(Array));
    expect('routesChangedAt' in brief).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain(w.chat.bot.authToken);
    const outside = await api(w.stranger, 'GET', path);
    expect(outside.body).toMatchObject({ code: 'FORBIDDEN', detail: expect.stringContaining('project.read') });
  });
});
