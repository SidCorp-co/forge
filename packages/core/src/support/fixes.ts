// A change's life (REQ-75 BC-13, BC-14; ISS-845): the session proposes one, naming who asked — a fix
// through the product API, a filing of Feedback, or a build, a deploy or a host command — and asks
// that person in its own words. Their plain answer ("ok", "yes", "no", in any language) is the consent: the session
// cites the message it is in, and core checks the citation against what the chat server signed —
// who wrote it, in which thread, and that it came after the proposal — before anything runs. Core
// makes the call or the filing, never the session, and hands what came of it back to the session
// as the act's answer; nothing of it is posted in the room by core. A filing waits in
// `support_proposals` as kind `filing`.

import {
  activeSupportApi,
  callGranted,
  planCall,
  type SupportCallArgs,
} from '../integrations/support-api/index.js';
import { runConfirmed } from './ability-run.js';
import { memberMessage } from './channel-store.js';
import { changeWaitsOnRole, mayConfirmChange, whoConfirms } from './confirm-role.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { changeName, nothingDone } from './propose.js';
import { fileRecord, type RecordRequest } from './record.js';
import { limitsOf } from './rules.js';
import {
  decideFix,
  expiredPendingFixes,
  fixesConfirmedSince,
  insertAction,
  type ProposalRow,
  pendingFixByCode,
  type RoomRow,
  settleFixResult,
} from './store.js';

/** The changes that wait on a confirmer the room's grant names, not on the asker (REQ-75 r5 BC-27). */
const CONFIRMER_KINDS = new Set<ProposalRow['kind']>(['build', 'deploy', 'command']);

/**
 * Whether a change waits on a confirmer rather than on its asker: a build, a deploy or a host
 * command anywhere, and in a channel agent's group a product-API fix too, since every change to a
 * running system there waits on a member whose role allows it (REQ-77 BC-10).
 */
const waitsOnConfirmer = (room: RoomRow, fix: ProposalRow): boolean =>
  CONFIRMER_KINDS.has(fix.kind) || (changeWaitsOnRole(room) && fix.kind === 'fix');

/** What an agreement came to, as the session is handed it to tell the thread in its own words. */
export type Agreed =
  | { declined: true; what: string }
  | {
      recorded: true;
      feedbackKey: string;
      created: boolean;
      what: string;
    }
  | { ran: boolean; what: string; result: unknown };

/**
 * The person's answer to a proposal, as the session cites it: the message `message` of thread
 * `thread`, agreeing or declining (`decision`). Refused, by name and to the session alone, when no
 * proposal waits under the handle, the message is no member's message of this room, it is in another
 * thread than the proposal's, it was written before the proposal, or its writer may not agree to
 * it: the asker for a fix or a filing, a confirmer the room allows for a build, a deploy or a host
 * change (the asker may still decline one). The writer is the chat server's attribution of the
 * message, never what it says.
 */
export async function agreeTo(
  room: RoomRow,
  input: {
    thread: string;
    proposal: string;
    message: string;
    decision?: 'agree' | 'decline' | undefined;
  },
): Promise<Outcome<Agreed>> {
  const decision = input.decision ?? 'agree';
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const audit = (
    kind: Parameters<typeof insertAction>[0]['kind'],
    fix: ProposalRow | null,
    writer: { key: string; label: string | null } | null,
    output: unknown,
  ) =>
    insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: fix?.thread ?? input.thread,
      kind,
      actorKind: writer ? 'member' : 'session',
      actorKey: writer?.key ?? null,
      actorLabel: writer?.label ?? null,
      tool: fix?.tool ?? null,
      // the audit fact: which message, cited by the session, said yes or no
      input: { proposal: input.proposal, message: input.message, decision, citedBy: 'session' },
      output,
      proposalId: fix?.id ?? null,
    });

  const fix = await pendingFixByCode(room.id, input.proposal);
  if (!fix) {
    return no(
      'SUPPORT_PROPOSAL_UNKNOWN',
      '/proposal',
      `no proposal waits under ${input.proposal} in this group: it ran, was declined or expired, or was never made. Nothing was done.`,
    );
  }
  const said = await memberMessage(room.id, input.message);
  if (!said) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      `${input.message} is no member's message this group received; cite the id of the message in which the person answered. Nothing was done.`,
    );
  }
  const writer = { key: said.authorKey, label: said.author };
  if (said.thread !== fix.thread || input.thread !== fix.thread) {
    await audit('refused', fix, writer, { reason: 'another thread', messageThread: said.thread });
    return no(
      'SUPPORT_AGREEMENT_OTHER_THREAD',
      '/message',
      `${input.proposal} was proposed in thread ${fix.thread}, and message ${input.message} is in thread ${said.thread}: only an answer in the proposal's own thread counts. Nothing was done.`,
    );
  }
  if (said.at.getTime() <= fix.createdAt.getTime()) {
    await audit('refused', fix, writer, { reason: 'before the proposal' });
    return no(
      'SUPPORT_AGREEMENT_BEFORE_PROPOSAL',
      '/message',
      `message ${input.message} was written before ${input.proposal} was proposed, so it answers something else: ask, and cite the answer that follows. Nothing was done.`,
    );
  }
  // the grant as the binding holds it now: a confirmer taken off the room since the proposal agrees to nothing
  const gated = waitsOnConfirmer(room, fix);
  const grants = grantsOf(await supportConfigOf(room));
  const allowed = gated
    ? (await mayConfirmChange(room, grants, writer)) ||
      (decision === 'decline' && writer.key === fix.askerKey)
    : writer.key === fix.askerKey;
  if (!allowed) {
    const who = gated ? whoConfirms(room, grants) : `@${fix.askerLabel ?? fix.askerKey}`;
    await audit('refused', fix, writer, {
      reason: gated ? 'not a confirmer' : 'not the asker',
      asker: fix.askerKey,
      ...(gated ? { confirmers: grants.confirmers ?? [] } : {}),
    });
    return no(
      'SUPPORT_NOT_A_CONFIRMER',
      '/message',
      `@${writer.label ?? writer.key} wrote ${input.message}, and only ${who} can agree to ${changeName(fix)}. ${nothingDone(fix)}`,
    );
  }
  const now = new Date();
  if (fix.expiresAt.getTime() <= now.getTime()) {
    if (await decideFix(fix.id, 'expired', now)) {
      await audit('fix_expired', fix, writer, { expiredAt: fix.expiresAt.toISOString() });
    }
    return no(
      'SUPPORT_PROPOSAL_EXPIRED',
      '/proposal',
      `${changeName(fix)} (${fix.code}) expired at ${fix.expiresAt.toISOString()} before anyone agreed. ${nothingDone(fix)} Propose it again if it is still wanted.`,
    );
  }
  if (decision === 'decline') {
    if (!(await decideFix(fix.id, 'declined', now))) return gone(input.proposal);
    await audit('fix_declined', fix, writer, null);
    return {
      ok: true,
      value: { declined: true, what: `${changeName(fix)} was declined. ${nothingDone(fix)}` },
    };
  }
  const config = await supportConfigOf(room);
  const limits = limitsOf(config);
  const today = new Date(now.getTime() - 24 * 60 * 60_000);
  if ((await fixesConfirmedSince(room.id, writer.key, today)) >= limits.fixesPerUserPerDay) {
    await audit('refused', fix, writer, {
      reason: 'limit',
      fixesPerUserPerDay: limits.fixesPerUserPerDay,
    });
    return no(
      'SUPPORT_LIMIT_REACHED',
      '/message',
      `@${writer.label ?? writer.key} has reached today's limit of ${limits.fixesPerUserPerDay} changes in this group. ${nothingDone(fix)}`,
    );
  }
  // the claim: of two agreements racing, one moves the row and runs it
  if (!(await decideFix(fix.id, 'ran', now))) return gone(input.proposal);
  await audit('fix_confirmed', fix, writer, null);
  if (fix.kind === 'filing') return recordAgreed(room, fix, conversationId);
  if (CONFIRMER_KINDS.has(fix.kind)) {
    const out = await runConfirmed(room, fix, conversationId, writer);
    return { ok: true, value: { ran: out.state === 'ran', what: out.what, result: out.result } };
  }
  return runFix(room, fix, limits.responseMaxBytes, conversationId);
}

const gone = (proposal: string): Outcome<never> =>
  no(
    'SUPPORT_PROPOSAL_UNKNOWN',
    '/proposal',
    `${proposal} was settled by another answer a moment ago; nothing more was done.`,
  );

/** A filing its asker agreed to: filed now, and the key or why it was not handed to the session. */
async function recordAgreed(
  room: RoomRow,
  fix: ProposalRow,
  conversationId: string,
): Promise<Outcome<Agreed>> {
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
    return { ok: false, refusals: filed.refusals };
  }
  await settleFixResult(fix.id, 'ran', { feedbackKey: filed.value.feedbackKey });
  return {
    ok: true,
    value: {
      recorded: true,
      feedbackKey: filed.value.feedbackKey,
      created: filed.value.created,
      what: `${changeName(fix)} was recorded as ${filed.value.feedbackKey}. You are told again once its result is final; tell the person it is recorded, in your words, and post nothing more before then.`,
    },
  };
}

async function runFix(
  room: RoomRow,
  fix: ProposalRow,
  maxBytes: number,
  conversationId: string,
): Promise<Outcome<Agreed>> {
  const api = await activeSupportApi(room.projectId);
  const args = (fix.args ?? {}) as SupportCallArgs;
  const planned =
    api && fix.tool
      ? planCall({ config: api.config, tools: api.tools, name: fix.tool, kind: 'fix', args })
      : null;
  if (!api || !planned || 'refusal' in planned) {
    // the grant changed between the proposal and the agreement: refused now, by the grant as it stands
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
    return {
      ok: true,
      value: { ran: false, what: `${changeName(fix)} was not run: ${detail}.`, result: null },
    };
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
  await settleFixResult(fix.id, result.ok ? 'ran' : 'failed', result);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: fix.thread,
    kind: result.ok ? 'fix_ran' : 'fix_failed',
    actorKind: 'core',
    tool: fix.tool,
    input: args,
    output: result,
    proposalId: fix.id,
  });
  const what = result.ok
    ? `${changeName(fix)} ran: ${planned.plan.tool.summary} answered ${result.status}.`
    : result.status === 0
      ? `${changeName(fix)} did not go through: ${planned.plan.tool.summary} could not be reached. Nothing else was tried.`
      : `${changeName(fix)} did not go through: ${planned.plan.tool.summary} answered ${result.status}. Nothing else was tried.`;
  return { ok: true, value: { ran: result.ok, what, result } };
}

/**
 * Expire every pending proposal past its time (a process timer), recorded and posted nowhere: the
 * session that asked learns it when it cites an answer, and asks again if it is still wanted.
 */
export async function expireSupportFixes(): Promise<void> {
  const now = new Date();
  for (const fix of await expiredPendingFixes(now)) {
    if (!(await decideFix(fix.id, 'expired', now))) continue;
    await insertAction({
      roomId: fix.roomId,
      projectId: fix.projectId,
      conversationId: null,
      thread: fix.thread,
      kind: 'fix_expired',
      actorKind: 'core',
      tool: fix.tool,
      proposalId: fix.id,
    });
  }
}
