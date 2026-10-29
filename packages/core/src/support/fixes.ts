// A change's life (REQ-75 BC-13, BC-14): the session proposes one, naming who asked — a fix through
// the product API, or a filing of Feedback; the group is shown it with a button that writes
// `confirm <code>`; only a message the Rocket.Chat server attributes to that same account, naming
// that code, makes it — anyone else's confirm is refused in the thread and does nothing. Core makes
// the call or the filing, never the session. Both wait in `support_fixes`: a filing under the
// reserved name `forge:record`, which no granted tool can take (a tool name is `[a-z][a-z0-9_]*`).

import type { SupportRoomConfig } from '@forge/contracts/support';
import {
  activeSupportApi,
  callGranted,
  planCall,
  type SupportCallArgs,
} from '../integrations/support-api/index.js';
import { runConfirmed } from './ability-run.js';
import { grantsOf, isConfirmer, supportConfigOf } from './grants.js';
import { changeName, nothingDone } from './propose.js';
import { fileRecord, type RecordRequest } from './record.js';
import { confirmRefusal, fixResultLine, limitsOf } from './rules.js';
import {
  decideFix,
  expiredPendingFixes,
  fixesConfirmedSince,
  insertAction,
  type ProposalRow,
  pendingFixByCode,
  type RoomRow,
  roomById,
  settleFixResult,
} from './store.js';
import { postInThread } from './thread.js';

/** The changes that wait on a confirmer the room's grant names, not on the asker (REQ-75 r5 BC-27). */
const CONFIRMER_KINDS = new Set<ProposalRow['kind']>(['build', 'deploy', 'command']);

/**
 * A confirmer-gated change is confirmed only by a confirmer the grant names, by the username the
 * chat server signed the message with; the asker or a confirmer may cancel it.
 */
function confirmerRefusal(
  grants: ReturnType<typeof grantsOf>,
  fix: ProposalRow,
  author: { key: string; label: string | null },
  verb: 'confirm' | 'cancel',
): string | null {
  if (isConfirmer(grants, author.label)) return null;
  if (verb === 'cancel' && author.key === fix.askerKey) return null;
  const who =
    (grants.confirmers ?? []).map((c) => `@${c}`).join(' or ') || 'a confirmer this room names';
  return `Only ${who} can confirm this change. ${nothingDone(fix)}`;
}

/** Tell the session what became of a fix, as a message of its own in the next turn. */
async function tellSession(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
  note: string,
): Promise<void> {
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: fix.thread,
    kind: 'message_in',
    actorKind: 'core',
    input: { note },
    externalId: `fix:${fix.id}:${note.slice(0, 24)}`,
    proposalId: fix.id,
  });
}

/**
 * A member's `confirm <code>` or `cancel <code>`. The author is the server's word for who wrote the
 * message; it runs the fix only when it is the account the fix was proposed to.
 */
export async function answerConfirm(input: {
  room: RoomRow;
  config: SupportRoomConfig;
  verb: 'confirm' | 'cancel';
  code: string;
  author: { key: string; label: string | null };
  thread: string;
  conversationId: string;
}): Promise<'ran' | 'failed' | 'declined' | 'refused' | 'unknown' | 'expired'> {
  const { room, author } = input;
  const record = (
    kind: Parameters<typeof insertAction>[0]['kind'],
    fix: ProposalRow | null,
    output: unknown,
  ) =>
    insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: input.conversationId,
      thread: fix?.thread ?? input.thread,
      kind,
      actorKind: 'member',
      actorKey: author.key,
      actorLabel: author.label,
      tool: fix?.tool ?? null,
      input: { verb: input.verb, code: input.code },
      output,
      proposalId: fix?.id ?? null,
    });
  const fix = await pendingFixByCode(room.id, input.code);
  if (!fix) {
    await record('refused', null, { reason: 'no change waits under this code' });
    await postInThread({
      room,
      thread: input.thread,
      text: `No change is waiting under ${input.code}. Nothing was done.`,
    });
    return 'unknown';
  }
  // the grant as the binding holds it now, never the routing's snapshot: a confirmer taken off the
  // room since the message was routed confirms nothing
  const grants = grantsOf(
    CONFIRMER_KINDS.has(fix.kind) ? await supportConfigOf(room) : input.config,
  );
  const refusedFor = CONFIRMER_KINDS.has(fix.kind)
    ? confirmerRefusal(grants, fix, author, input.verb)
    : confirmRefusal(fix, author.key, nothingDone(fix));
  if (refusedFor) {
    await record('refused', fix, {
      reason: CONFIRMER_KINDS.has(fix.kind) ? 'not a confirmer' : 'not the asker',
      asker: fix.askerKey,
      ...(CONFIRMER_KINDS.has(fix.kind) ? { confirmers: grants.confirmers ?? [] } : {}),
    });
    await postInThread({ room, thread: fix.thread, text: refusedFor });
    return 'refused';
  }
  const now = new Date();
  if (fix.expiresAt.getTime() <= now.getTime()) {
    if (await decideFix(fix.id, 'expired', now)) {
      await record('fix_expired', fix, { expiredAt: fix.expiresAt.toISOString() });
      await postInThread({
        room,
        thread: fix.thread,
        text: `That change (${fix.code}) expired before it was confirmed. ${nothingDone(fix)} Ask again if you still need it.`,
      });
    }
    return 'expired';
  }
  if (input.verb === 'cancel') {
    if (!(await decideFix(fix.id, 'declined', now))) return 'unknown';
    await record('fix_declined', fix, null);
    await postInThread({
      room,
      thread: fix.thread,
      text: `Cancelled ${fix.code}. ${nothingDone(fix)}`,
    });
    await tellSession(
      room,
      fix,
      input.conversationId,
      `${changeName(fix)} (${fix.code}) was cancelled by the person who asked. ${nothingDone(fix)}`,
    );
    return 'declined';
  }
  const limits = limitsOf(input.config);
  const today = new Date(now.getTime() - 24 * 60 * 60_000);
  if ((await fixesConfirmedSince(room.id, author.key, today)) >= limits.fixesPerUserPerDay) {
    await record('refused', fix, {
      reason: 'limit',
      fixesPerUserPerDay: limits.fixesPerUserPerDay,
    });
    await postInThread({
      room,
      thread: fix.thread,
      text: `You have reached today's limit of ${limits.fixesPerUserPerDay} changes in this group. ${nothingDone(fix)}`,
    });
    return 'refused';
  }
  // the claim: of two confirms racing, one moves the row and runs it
  const claimed = await decideFix(fix.id, 'ran', now);
  if (!claimed) return 'unknown';
  await record('fix_confirmed', fix, null);
  if (fix.kind === 'filing') return recordConfirmed(room, fix, input.conversationId);
  if (CONFIRMER_KINDS.has(fix.kind)) {
    return runConfirmed(
      room,
      fix,
      input.conversationId,
      (note) => tellSession(room, fix, input.conversationId, note),
      author.label,
    );
  }
  return runFix(room, fix, limits.responseMaxBytes, input.conversationId);
}

/** A filing its asker confirmed: filed now, and the session told the key or why it was not. */
async function recordConfirmed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
): Promise<'ran' | 'failed'> {
  const filed = await fileRecord(room, {
    ...(fix.args as RecordRequest),
    reporter: { key: fix.askerKey, label: fix.askerLabel },
  });
  if (!filed.ok) {
    const detail = filed.refusals.map((r) => r.detail).join('; ');
    await settleFixResult(fix.id, 'failed', { refused: detail });
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: fix.thread,
      kind: 'fix_failed',
      actorKind: 'core',
      tool: fix.tool,
      input: fix.args,
      output: { refused: detail },
      proposalId: fix.id,
    });
    await postInThread({ room, thread: fix.thread, text: `It was not recorded: ${detail}.` });
    await tellSession(
      room,
      fix,
      conversationId,
      `${changeName(fix)} (${fix.code}) was confirmed but not recorded: ${detail}.`,
    );
    return 'failed';
  }
  await settleFixResult(fix.id, 'ran', { feedbackKey: filed.value.feedbackKey });
  await tellSession(
    room,
    fix,
    conversationId,
    `${changeName(fix)} (${fix.code}) was recorded as ${filed.value.feedbackKey} after the asker confirmed it. You are told again once its result is final; post nothing before then.`,
  );
  return 'ran';
}

async function runFix(
  room: RoomRow,
  fix: ProposalRow,
  maxBytes: number,
  conversationId: string,
): Promise<'ran' | 'failed'> {
  const api = await activeSupportApi(room.projectId);
  const args = (fix.args ?? {}) as SupportCallArgs;
  const planned =
    api && fix.tool
      ? planCall({ config: api.config, tools: api.tools, name: fix.tool, kind: 'fix', args })
      : null;
  if (!api || !planned || 'refusal' in planned) {
    // the grant changed between the proposal and the confirm: refused now, by the grant as it stands
    const detail = !api
      ? 'this project no longer grants its support session tools'
      : planned && 'refusal' in planned
        ? planned.refusal.detail
        : 'not callable';
    await settleFixResult(fix.id, 'failed', { refused: detail });
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: fix.thread,
      kind: 'fix_failed',
      actorKind: 'core',
      tool: fix.tool,
      input: args,
      output: { refused: detail },
      proposalId: fix.id,
    });
    await postInThread({ room, thread: fix.thread, text: `The change was not run: ${detail}.` });
    await tellSession(
      room,
      fix,
      conversationId,
      `${changeName(fix)} (${fix.code}) was confirmed but not run: ${detail}.`,
    );
    return 'failed';
  }
  const called = await callGranted({
    plan: planned.plan,
    config: api.config,
    headers: api.headers,
    maxBytes,
  });
  const result =
    'result' in called
      ? called.result
      : { status: 0, ok: false, body: called.refusal.detail, truncated: false, durationMs: 0 };
  const state = result.ok ? 'ran' : 'failed';
  await settleFixResult(fix.id, state, result);
  const posted = await postInThread({
    room,
    thread: fix.thread,
    text: fixResultLine(planned.plan.tool.summary, result.status, result.ok),
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: fix.thread,
    kind: result.ok ? 'fix_ran' : 'fix_failed',
    actorKind: 'core',
    tool: fix.tool,
    input: args,
    output: result,
    externalId: posted.messageId,
    proposalId: fix.id,
  });
  await tellSession(
    room,
    fix,
    posted.conversationId,
    `${changeName(fix)} (${fix.code}) ran after the asker confirmed it: answered ${result.status}. What came back: ${JSON.stringify(result.body).slice(0, 2000)}`,
  );
  return state;
}

/** Expire every pending fix past its time, telling its thread (a process timer). */
export async function expireSupportFixes(): Promise<void> {
  const now = new Date();
  for (const fix of await expiredPendingFixes(now)) {
    if (!(await decideFix(fix.id, 'expired', now))) continue;
    const room = await roomById(fix.roomId);
    if (!room) continue;
    const posted = await postInThread({
      room,
      thread: fix.thread,
      text: `The change ${fix.code} expired before it was confirmed. ${nothingDone(fix)}`,
    }).catch(() => null);
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: posted?.conversationId ?? null,
      thread: fix.thread,
      kind: 'fix_expired',
      actorKind: 'core',
      tool: fix.tool,
      proposalId: fix.id,
      externalId: posted?.messageId ?? null,
    });
  }
}
