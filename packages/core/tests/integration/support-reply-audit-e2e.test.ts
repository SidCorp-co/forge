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

/** The member asks in a new thread, the session replies `text`, then audits it with `failed`. */
async function replyAndAudit(
  ask: string,
  text: string,
  failed: Array<{ line: string; why: string }> | null,
  /** Run after the reply is posted and before it is audited, in the same turn. */
  inTurn?: (message: string) => Promise<void>,
): Promise<{ thread: string; message: string; audit: Audit | null }> {
  await w.settleWarm();
  let message = '';
  let audit: Audit | null = null;
  w.box.model = async (turn, act) => {
    const m = turn.messages.find((x) => x.from !== 'forge' && x.text === ask);
    if (!m) return;
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
  const thread = await chat.say(chat.bob, ask);
  await w.untilLines((lines) => lines.some((l) => l.tmid === thread && l.text === text));
  await w.settleWarm();
  w.box.model = async () => {};
  return { thread, message, audit };
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
