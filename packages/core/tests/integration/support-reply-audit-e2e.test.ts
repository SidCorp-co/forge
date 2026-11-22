import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
  // the API's public host, which no person-facing link may point at
  process.env.PUBLIC_API_BASE_URL = 'https://forge-api.example.test';
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/reply-audit/audit.ts
// @direct-test-of packages/core/src/support/reply-audit/answering-language.ts
// @direct-test-of packages/core/src/support/reply-audit/read.ts
// @direct-test-of packages/core/src/support/reply-audit/route.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/look-act.ts
// @direct-test-of packages/core/src/support/screen-claims.ts
// @direct-test-of packages/core/src/support/room-day.ts
// @direct-test-of packages/core/src/support/thread-answer.ts
// @direct-test-of packages/core/src/support/actions-route.ts
// @direct-test-of packages/core/src/support/dated-reads.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/db/schema-support-verdicts.ts
//
// ISS-1250 (owner 2026-11-16, "teach the flow, not block it"): right after it posts a reply, a room's
// agent audits it with support.audit. The verdict is kept per reply with what code found beside the
// agent's own reading; a failed one is a room correction in the lessons store (REQ-50); a project
// reader reads every verdict per bot, with the replies its agent left unaudited. Nothing blocks a post.
// ISS-1377 (FB-789): the project writes its records in English, as sid-desk does; a reply is held to
// the language the room is answered in (the person's, else the persona's), never that one.

const BAD =
  'Go to the project settings page on Forge and set it there: https://forge-api.example.test/projects/catalog/settings';
const GOOD = 'The export is under Reports, then CSV.';
const LATER = 'The labels print from the Orders page.';

const w = new SupportWorld();
let chat: StandInRocketChat;
type Audit = { status: number; body: Record<string, unknown> };

/** The member asks in a new thread (or `inThread`), the session replies `text`, then audits it with `failed`. */
async function replyAndAudit(
  ask: string,
  text: string,
  failed: Array<{ line: string; why: string }> | null,
  /** Run after the reply is posted and before it is audited, in the same turn. */
  inTurn?: (message: string) => Promise<void>,
  inThread?: string,
): Promise<{ thread: string; message: string; audit: Audit | null; handed: string }> {
  await w.settleWarm();
  let message = '';
  let audit: Audit | null = null;
  let handed = '';
  w.box.model = async (turn, act) => {
    const m = turn.messages.find((x) => x.from !== 'forge' && x.text === ask);
    if (!m) return;
    handed = turn.text;
    const posted = await act({ action: 'reply', thread: m.thread, text });
    message = String(posted.messageId);
    if (inTurn) await inTurn(message);
    if (!failed) return;
    const res = await fetch(`${w.core.base}/api/projects/${w.projectId}/support/session/audits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${turn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ thread: m.thread, message, failed }),
    });
    audit = { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const said = await chat.say(chat.bob, ask, inThread);
  const thread = inThread ?? said;
  await w.untilLines((lines) => lines.some((l) => l.tmid === thread && l.text === text));
  await w.settleWarm();
  w.box.model = async () => {};
  return { thread, message, audit, handed };
}

const verdicts = () =>
  rows<{
    room_kind: string;
    bot: string;
    message: string;
    verdict: string;
    failed: string[];
    correction_id: string | null;
  }>(sql`SELECT room_kind, bot, message, verdict, failed, correction_id
           FROM support_reply_verdicts WHERE project_id = ${w.projectId}::uuid ORDER BY audited_at`);

beforeAll(async () => {
  await w.start();
  await seedProjectDocument(w.projectId, w.ownerId, {
    environments: {},
    extra: { contentLanguage: 'en' },
  });
  await w.bind();
  chat = w.chat as StandInRocketChat;
}, 120_000);

afterAll(() => w.stop());

describe('a room agent audits its own reply with support.audit (ISS-1250)', () => {
  it('keeps a failed verdict with what code found beside its reading, as a room correction', async () => {
    const { message, audit } = await replyAndAudit('Where do I set the language?', BAD, [
      { line: 'answered', why: 'I sent the member away instead of setting it' },
    ]);
    expect(audit?.status, JSON.stringify(audit?.body)).toBe(200);
    expect(audit?.body).toMatchObject({
      verdict: 'fail',
      failed: ['answered', 'no_ui_directions', 'web_links'],
      already: false,
    });
    const findings = audit?.body.findings as Array<{ line: string; by: string }>;
    expect(findings.map((f) => [f.line, f.by])).toEqual([
      ['answered', 'agent'],
      ['no_ui_directions', 'code'],
      ['web_links', 'code'],
    ]);
    const [kept] = await verdicts();
    expect(kept).toMatchObject({
      room_kind: 'support',
      bot: w.rcConnectionId,
      message,
      verdict: 'fail',
    });
    const [correction] = await rows<{
      id: string;
      source_ref: string;
      agency: string;
      score: number;
      reason: string;
    }>(
      sql`SELECT id, source_ref, agency, score, reason FROM corrections
           WHERE project_id = ${w.projectId}::uuid AND source = 'room'`,
    );
    expect(correction?.id).toBe(kept?.correction_id);
    expect(correction).toMatchObject({ agency: 'agent', score: 1 });
    expect(correction?.source_ref).toContain(message);
    expect(correction?.reason).toContain('web_links');
    expect(audit?.body.correctionId).toBe(correction?.id);
  }, 90_000);

  it('passes a reply that fails no line, keeping no correction, and answers a second audit unchanged', async () => {
    const { thread, message, audit } = await replyAndAudit('Where is the CSV export?', GOOD, []);
    expect(audit?.body).toMatchObject({ verdict: 'pass', failed: [], correctionId: null });
    const before = await verdicts();
    // a second audit of the same reply, under a turn of its own, answers the kept verdict
    await w.settleWarm();
    let again: Audit | null = null;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.text === 'thanks');
      if (!m) return;
      await act({ action: 'silent', thread, message: m.message, reason: 'thanks' });
      const res = await fetch(`${w.core.base}/api/projects/${w.projectId}/support/session/audits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${turn.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          thread,
          message,
          failed: [{ line: 'accurate', why: 'second try' }],
        }),
      });
      again = { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    await chat.say(chat.bob, 'thanks', thread);
    await expect.poll(() => again, { timeout: 30_000 }).not.toBeNull();
    await w.settleWarm();
    w.box.model = async () => {};
    expect((again as Audit | null)?.body).toMatchObject({ verdict: 'pass', already: true });
    expect(await verdicts()).toHaveLength(before.length);
  }, 90_000);

  it('refuses an audit of a message that is no reply the session posted, keeping nothing', async () => {
    await w.settleWarm();
    let refused: Audit | null = null;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.text === 'Is the import done?');
      if (!m) return;
      await act({ action: 'silent', thread: m.thread, message: m.message, reason: 'test' });
      const res = await fetch(`${w.core.base}/api/projects/${w.projectId}/support/session/audits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${turn.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ thread: m.thread, message: m.message, failed: [] }),
      });
      refused = { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const before = await verdicts();
    await chat.say(chat.bob, 'Is the import done?');
    await expect.poll(() => refused, { timeout: 30_000 }).not.toBeNull();
    await w.settleWarm();
    w.box.model = async () => {};
    expect(JSON.stringify((refused as Audit | null)?.body)).toContain('SUPPORT_MESSAGE_UNKNOWN');
    expect(await verdicts()).toHaveLength(before.length);
  }, 90_000);

  it('reads every verdict per project and bot, counting the replies left unaudited', async () => {
    await replyAndAudit('Where are the labels?', LATER, null);
    const path = `/api/projects/${w.projectId}/support/reply-verdicts`;
    const got = await api(w.owner, 'GET', path);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.bots).toEqual([
      { bot: w.rcConnectionId, replies: 3, audited: 2, pass: 1, fail: 1 },
    ]);
    const listed = got.body.verdicts as Array<Record<string, unknown>>;
    expect(listed.map((v) => v.verdict)).toEqual(['pass', 'fail']);
    expect(listed[1]).toMatchObject({ roomKind: 'support', rid: chat.rid, bot: w.rcConnectionId });

    const failed = await api(w.owner, 'GET', `${path}?verdict=fail&bot=${w.rcConnectionId}`);
    expect((failed.body.verdicts as unknown[]).length).toBe(1);
    const other = await api(w.owner, 'GET', `${path}?bot=${randomUUID()}`);
    expect(other.body).toMatchObject({ verdicts: [], bots: [], truncated: false });
    const bad = await api(w.owner, 'GET', `${path}?verdict=maybe`);
    expect(bad.status).toBe(400);
    const stranger = await api(w.stranger, 'GET', path);
    expect([403, 404]).toContain(stranger.status);
  }, 90_000);
  it('fails an English reply to a Vietnamese message where the persona names no language, naming both (ISS-1377)', async () => {
    const { audit } = await replyAndAudit(
      'Đơn hàng của em đã giao chưa ạ?', // i18n-allow: a member writing Vietnamese (ISS-1377)
      'Your order was delivered yesterday and the tracking code is in the email we sent.',
      [],
    );
    expect(audit?.status, JSON.stringify(audit?.body)).toBe(200);
    expect(audit?.body).toMatchObject({ verdict: 'fail', failed: ['language'] });
    const findings = (audit?.body.findings ?? []) as Array<{
      line: string;
      why: string;
      by: string;
    }>;
    const [finding] = findings;
    expect(finding).toMatchObject({ line: 'language', by: 'code' });
    expect(finding?.why).toContain('English');
    expect(finding?.why).toContain('Vietnamese');
  }, 90_000);

  it('passes a Vietnamese reply to a Vietnamese message in a room whose project writes records in English (ISS-1377)', async () => {
    const regranted = await w.regrant({
      product: 'Catalog, the shop back office',
      grants: { abilities: ['read_checkout', 'file_items'] },
      persona: 'You are the shop desk assistant. Reply in plain Vietnamese, short and warm.',
    });
    expect(regranted.status, JSON.stringify(regranted.body)).toBe(200);
    const { audit } = await replyAndAudit(
      'Đơn hàng số 42 của em giao tới đâu rồi ạ?', // i18n-allow: a member writing Vietnamese (ISS-1377)
      'Dạ, đơn hàng số 42 của anh đã giao hôm qua, mã vận đơn nằm trong email bên em đã gửi ạ.', // i18n-allow: the room's Vietnamese reply (ISS-1377)
      [],
    );
    expect(audit?.status, JSON.stringify(audit?.body)).toBe(200);
    expect(audit?.body).toMatchObject({ verdict: 'pass', failed: [] });
  }, 90_000);

  // ISS-1354 (FB-763): "Không có tài khoản API PGPrints" rested on a supplier read from an earlier
  // turn; the audit's `accurate` line, told by code, fails a live-state claim no read of its own turn holds
  it('fails accurate on a live-state claim resting on an earlier turn’s read, and passes it on a read of its own turn', async () => {
    // a declared read of the supplier, recorded in the reply's own turn as `support.read` records one
    const readInTurnOf = async (message: string) => {
      await rows(sql`INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input, session_id, turn_id)
               SELECT room_id, project_id, thread, 'diagnose', 'session', 'read', '{"name":"supplier"}'::jsonb, session_id, turn_id
                 FROM support_actions WHERE kind = 'reply' AND external_id = ${message}`);
    };
    const claim = 'There is no PGPrints API account on staging yet.';
    const first = await replyAndAudit(
      'Does staging have the PGPrints account?',
      claim,
      [],
      readInTurnOf,
    );
    expect(first.audit?.body, JSON.stringify(first.audit?.body)).toMatchObject({
      verdict: 'pass',
      failed: [],
    });
    const later = await replyAndAudit('And the PGPrints account, is it there now?', claim, []);
    expect(later.audit?.status, JSON.stringify(later.audit?.body)).toBe(200);
    expect(later.audit?.body).toMatchObject({ verdict: 'fail', failed: ['accurate'] });
    const [finding] = (later.audit?.body.findings ?? []) as Array<{
      line: string;
      why: string;
      by: string;
    }>;
    expect(finding).toMatchObject({ line: 'accurate', by: 'code' });
    expect(finding?.why).toContain('"There is no PGPrints API account"');
    expect(finding?.why).toContain('from a read made in an earlier turn');
  }, 120_000);
});

describe("a room's claim of a release's issues closed is held to a read of its turn (ISS-1389)", () => {
  // ISS-1389 (FB-801): a release's issues said closed from the plan; an issue read of the turn holds the claim
  it('fails accurate on a release’s issues said closed with no issue read of its turn, and passes it after one', async () => {
    const issuesReadInTurnOf = async (message: string) => {
      await rows(sql`INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input, session_id, turn_id)
               SELECT room_id, project_id, thread, 'operation', 'session', 'issues', '{"action":"issues"}'::jsonb, session_id, turn_id
                 FROM support_actions WHERE kind = 'reply' AND external_id = ${message}`);
    };
    const claim = 'The 16 issues of release 0.29.0 are already closed.';
    const read = await replyAndAudit(
      'Are release 0.29.0 issues closed?',
      claim,
      [],
      issuesReadInTurnOf,
    );
    expect(read.audit?.body, JSON.stringify(read.audit?.body)).toMatchObject({
      verdict: 'pass',
      failed: [],
    });
    const unread = await replyAndAudit('And now, are they closed?', claim, []);
    expect(unread.audit?.body).toMatchObject({ verdict: 'fail', failed: ['accurate'] });
    const [finding] = (unread.audit?.body.findings ?? []) as Array<{ why: string }>;
    expect(finding?.why).toContain('support.issues or support.releases');
  }, 120_000);
});

// ISS-1356 (owner 2026-11-19: "it confirms UI that is not there"): a reply's row shows which claim
// about a screen carried a look of its turn, and which reply corrected an earlier post; the room's
// daily line counts both per turn and names an owner message left 30 minutes without an answer. A
// look stands in here as the look act records one (the box itself needs a device this world lacks).
describe("a room's screen claims, corrections and the owner's waits, on its record and its day (ISS-1356)", () => {
  const replyRow = (message: string) =>
    rows<{ output: { screen?: { claim: string; looks: string[] }; correction?: string } | null }>(
      sql`SELECT output FROM support_actions WHERE kind = 'reply' AND external_id = ${message}`,
    ).then((r) => r[0]?.output ?? null);
  const box = randomUUID();
  // a look of the running turn, recorded as support.look records one
  const lookInTurn = async (thread: string) => {
    await rows(sql`INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input, session_id, turn_id)
             SELECT r.id, r.project_id, ${thread}, 'operation', 'session', 'look', jsonb_build_object('box', ${box}::text), r.session_id, t.id
               FROM support_rooms r JOIN support_session_turns t ON t.session_id = r.session_id AND t.ended_at IS NULL
              WHERE r.project_id = ${w.projectId}::uuid`);
  };

  it('marks a screen claim with the look its turn took, and fails accurate on one no look holds', async () => {
    const claim = 'You will see the Export button on the Orders page.';
    let seen = '';
    await w.settleWarm();
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.from !== 'forge' && x.text === 'Where is the export?');
      if (!m) return;
      await lookInTurn(m.thread);
      seen = String((await act({ action: 'reply', thread: m.thread, text: claim })).messageId);
    };
    await chat.say(chat.bob, 'Where is the export?');
    await expect.poll(() => seen, { timeout: 30_000 }).not.toBe('');
    await w.settleWarm();
    w.box.model = async () => {};
    expect(await replyRow(seen)).toMatchObject({
      screen: { claim: 'You will see the Export button on the Orders page', looks: [box] },
    });

    const unseen = await replyAndAudit('And the import button?', claim, []);
    expect(await replyRow(unseen.message)).toMatchObject({ screen: { looks: [] } });
    expect(unseen.audit?.body).toMatchObject({ verdict: 'fail', failed: ['accurate'] });
    expect(JSON.stringify(unseen.audit?.body.findings)).toContain('this turn took no look at it');
  }, 120_000);

  it('counts a correction against its turn, and names the owner message left 30 minutes unanswered, on the day', async () => {
    const regranted = await w.regrant({
      product: 'Catalog, the shop back office',
      grants: { abilities: ['read_checkout', 'file_items'], owner: chat.alice.userId },
    });
    expect(regranted.status, JSON.stringify(regranted.body)).toBe(200);
    const fixed = await replyAndAudit(
      'Is the export hourly?',
      'Correction: the export runs nightly, not hourly.',
      null,
    );
    expect(await replyRow(fixed.message)).toMatchObject({ correction: 'Correction:' });

    await w.settleWarm();
    let silent = false;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.text === 'Sao rồi?'); // i18n-allow: the owner's quoted message (ISS-1356)
      if (!m) return;
      await act({
        action: 'silent',
        thread: m.thread,
        message: m.message,
        reason: 'test: left unanswered',
      });
      silent = true;
    };
    const waiting = await chat.say(chat.alice, 'Sao rồi?'); // i18n-allow: the owner's quoted message (ISS-1356)
    await expect.poll(() => silent, { timeout: 30_000 }).toBe(true);
    await w.settleWarm();
    w.box.model = async () => {};

    const [room] = await rows<{ id: string }>(
      sql`SELECT id FROM support_rooms WHERE project_id = ${w.projectId}::uuid`,
    );
    // ISS-1422: a release-check report lands in his thread; it answers nobody, so his wait runs on
    // [REPORT_ENDED_THE_WAIT] before the fix: the day read him answered at the report
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input, external_id)
      VALUES (${room?.id}::uuid, ${w.projectId}, ${waiting}, 'routed', 'session', 'master_post',
              '{"text": "Release 0.310.0 checked.", "report": "release 0.310.0"}'::jsonb, 'report-1422')`);
    const until = new Date(Date.now() + 31 * 60_000).toISOString();
    const path = `/api/projects/${w.projectId}/support/rooms/${room?.id}/day?until=${encodeURIComponent(until)}`;
    const got = await api(w.owner, 'GET', path);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.corrections).toMatchObject({ count: 1 });
    expect(
      (got.body.corrections as { items: { message: string; turn: string | null }[] }).items[0],
    ).toMatchObject({
      message: fixed.message,
    });
    expect(got.body.screenClaims).toMatchObject({ count: 2, looked: 1 });
    const owed = got.body.ownerWaiting as {
      thread: string;
      answeredAt: string | null;
      minutes: number;
    }[];
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ thread: waiting, answeredAt: null });
    expect(owed[0]?.minutes).toBeGreaterThanOrEqual(30);
    const stranger = await api(w.stranger, 'GET', path);
    expect([403, 404]).toContain(stranger.status);
  }, 120_000);

  it('refuses a look at an environment the project does not declare, naming those it does', async () => {
    await w.settleWarm();
    let refused: unknown = null;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.text === 'Can you check the staging screen?');
      if (!m) return;
      refused = await act({ action: 'look', thread: m.thread, environment: 'staging' }).catch(
        (e: unknown) => String(e),
      );
      await act({ action: 'silent', thread: m.thread, message: m.message, reason: 'test' });
    };
    await chat.say(chat.bob, 'Can you check the staging screen?');
    await expect.poll(() => refused, { timeout: 30_000 }).not.toBeNull();
    await w.settleWarm();
    w.box.model = async () => {};
    expect(JSON.stringify(refused)).toContain('SUPPORT_LOOK_ENVIRONMENT_UNKNOWN');
    expect(JSON.stringify(refused)).toContain('its environments with one are none');
  }, 90_000);
});

// ISS-1416 (FB-824, forge L-168): "chưa bật" and "vẫn tắt" were stated from reads a turn or a day old,
// which sat undated in the resident session's context; and a raise was told landed in AdminHub API's
// technical thread when it had been refused there. The turn after a read names when it was made, and
// the audit holds a report of an act to an act of its own turn that landed.
describe('an earlier read is dated as a turn opens, and an act is told from its result (ISS-1416)', () => {
  const actInTurnOf = (kind: string, tool: string) => async (message: string) => {
    await rows(sql`INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, tool, input, session_id, turn_id)
             SELECT room_id, project_id, thread, ${kind}, 'session', ${tool}, '{}'::jsonb, session_id, turn_id
               FROM support_actions WHERE kind = 'reply' AND external_id = ${message}`);
  };

  it('names the last read’s time as the next turn opens, and fails a setting said off from it', async () => {
    const read = await replyAndAudit(
      'Is the sync flag on in staging?',
      'I read the staging flags now.',
      [],
      actInTurnOf('diagnose', 'read'),
    );
    const [last] = await rows<{ at: string }>(
      sql`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
            FROM support_actions WHERE kind = 'diagnose' AND thread = ${read.thread}`,
    );
    const at = String(last?.at);
    const claim = 'The sync flag is still disabled on staging.';
    const later = await replyAndAudit('Is the sync flag still off?', claim, []);
    expect(later.handed).toContain(
      `Your last read of live state (a read, run, issue, release, deployment or look) was at ${at}, in an earlier turn: it is not current.`,
    );
    expect(later.handed).toContain('Read again before you say a setting is on or off');
    expect(later.audit?.body).toMatchObject({ verdict: 'fail', failed: ['accurate'] });
    expect(JSON.stringify(later.audit?.body.findings)).toContain(
      `from a read made in an earlier turn (${at})`,
    );
  }, 120_000);

  // ISS-1423 (FB-828): a raise that landed in an earlier turn of the thread is reported truthfully later
  it('fails accurate on a raise reported with no act landed, and passes it after a raise landed in its turn or earlier in its thread', async () => {
    const claim = "The host step was already raised in the project's technical thread.";
    const refused = await replyAndAudit('Did the host step reach the owner?', claim, []);
    expect(refused.audit?.body).toMatchObject({ verdict: 'fail', failed: ['accurate'] });
    expect(JSON.stringify(refused.audit?.body.findings)).toContain(
      'no act landed in this turn or earlier in this thread',
    );
    const pass = { verdict: 'pass', failed: [] };
    const routed = actInTurnOf('routed', 'technical');
    const landed = await replyAndAudit('And the database step?', claim, [], routed);
    expect(landed.audit?.body, JSON.stringify(landed.audit?.body)).toMatchObject(pass);
    const earlier = "I raised it in the project's technical thread earlier.";
    const later = await replyAndAudit('Any news?', earlier, [], undefined, landed.thread);
    expect(later.audit?.body, JSON.stringify(later.audit?.body)).toMatchObject(pass);
    const elsewhere = await replyAndAudit('And the cache step?', claim, []);
    expect(elsewhere.audit?.body).toMatchObject({ verdict: 'fail', failed: ['accurate'] });
  }, 180_000);
});
