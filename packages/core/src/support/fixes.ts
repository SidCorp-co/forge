// A fix's life (REQ-75 BC-13): the session proposes one, naming who asked; the group is shown it
// with a button that writes `confirm <code>`; only a message the Rocket.Chat server attributes to
// that same account, naming that code, runs it — anyone else's confirm is refused in the thread
// and runs nothing. Core makes the call, never the session.

import { SUPPORT_FIX_TTL_MS, type SupportRoomConfig } from '@forge/contracts/support';
import type { RocketChatButtonAttachment } from '../integrations/rocketchat/index.js';
import {
  activeSupportApi,
  callGranted,
  planCall,
  type SupportCallArgs,
} from '../integrations/support-api/index.js';
import { type Refusal, refusalOf } from './refusals.js';
import {
  confirmPrompt,
  confirmRefusal,
  fixResultLine,
  limitsOf,
  mintConfirmCode,
} from './rules.js';
import {
  decideFix,
  expiredPendingFixes,
  type FixRow,
  fixesConfirmedSince,
  insertAction,
  insertFix,
  pendingFixByCode,
  type RoomRow,
  roomById,
  settleFixResult,
  threadMembers,
} from './store.js';
import { noteInThread, postInThread } from './thread.js';

export type ProposeOutcome =
  | { ok: true; fixId: string; code: string; messageId: string | null }
  | { ok: false; refusals: Refusal[] };

const buttons = (code: string): RocketChatButtonAttachment[] => [
  {
    actions: [
      {
        type: 'button',
        text: 'Confirm',
        msg: `confirm ${code}`,
        msg_in_chat_window: true,
        msg_processing_type: 'sendMessage',
      },
      {
        type: 'button',
        text: 'Cancel',
        msg: `cancel ${code}`,
        msg_in_chat_window: true,
        msg_processing_type: 'sendMessage',
      },
    ],
  },
];

export async function proposeFix(input: {
  room: RoomRow;
  thread: string;
  tool: string;
  args: SupportCallArgs;
  asker: string;
}): Promise<ProposeOutcome> {
  const { room } = input;
  const members = await threadMembers(room.id, input.thread);
  if (members.length === 0) {
    return {
      ok: false,
      refusals: [
        refusalOf(
          'SUPPORT_THREAD_UNKNOWN',
          '/thread',
          `no member has written in thread ${input.thread} of this group`,
        ),
      ],
    };
  }
  const asker = members.find((m) => m.key === input.asker);
  if (!asker) {
    return {
      ok: false,
      refusals: [
        refusalOf(
          'SUPPORT_ASKER_NOT_IN_THREAD',
          '/asker',
          `account ${input.asker} has not written in this thread; the asker is one of ${members.map((m) => `${m.key} (${m.label ?? 'no name'})`).join(', ')}`,
        ),
      ],
    };
  }
  const api = await activeSupportApi(room.projectId);
  if (!api) {
    return {
      ok: false,
      refusals: [
        refusalOf(
          'SUPPORT_TOOLS_UNBOUND',
          '/tool',
          'this project grants its support session no tools: bind a support-api integration first',
        ),
      ],
    };
  }
  const planned = planCall({
    config: api.config,
    tools: api.tools,
    name: input.tool,
    kind: 'fix',
    args: input.args,
  });
  if ('refusal' in planned) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: null,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'session',
      tool: input.tool,
      input: input.args,
      output: planned.refusal,
    });
    return {
      ok: false,
      refusals: [refusalOf(planned.refusal.code, '/tool', planned.refusal.detail)],
    };
  }
  const now = new Date();
  let fix: FixRow | null = null;
  for (let attempt = 0; attempt < 5 && !fix; attempt++) {
    fix = await insertFix({
      roomId: room.id,
      projectId: room.projectId,
      thread: input.thread,
      tool: planned.plan.tool.name,
      args: input.args,
      askerKey: asker.key,
      askerLabel: asker.label,
      code: mintConfirmCode(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + SUPPORT_FIX_TTL_MS),
    });
  }
  if (!fix) throw new Error('support: five codes in a row were taken; no fix was proposed');
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: confirmPrompt({
      askerLabel: asker.label,
      summary: planned.plan.tool.summary,
      args: input.args,
      code: fix.code,
    }),
    attachments: buttons(fix.code),
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'fix_proposed',
    actorKind: 'session',
    tool: fix.tool,
    input: input.args,
    output: { code: fix.code, asker: asker.key, expiresAt: fix.expiresAt.toISOString() },
    externalId: posted.messageId,
    fixId: fix.id,
  });
  await noteInThread(
    posted.conversationId,
    `Fix proposed: ${fix.tool}, waiting on ${asker.label ?? asker.key} to confirm ${fix.code}.`,
  );
  return { ok: true, fixId: fix.id, code: fix.code, messageId: posted.messageId };
}

/** Tell the session what became of a fix, as a message of its own in the next turn. */
async function tellSession(
  room: RoomRow,
  fix: FixRow,
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
    fixId: fix.id,
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
    fix: FixRow | null,
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
      fixId: fix?.id ?? null,
    });
  const fix = await pendingFixByCode(room.id, input.code);
  if (!fix) {
    await record('refused', null, { reason: 'no change waits under this code' });
    await postInThread({
      room,
      thread: input.thread,
      text: `No change is waiting under ${input.code}. Nothing was run.`,
    });
    return 'unknown';
  }
  const refusedFor = confirmRefusal(fix, author.key);
  if (refusedFor) {
    await record('refused', fix, { reason: 'not the asker', asker: fix.askerKey });
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
        text: `That change (${fix.code}) expired before it was confirmed. Nothing was run; ask again if you still need it.`,
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
      text: `Cancelled ${fix.code}. Nothing was changed.`,
    });
    await tellSession(
      room,
      fix,
      input.conversationId,
      `The fix ${fix.tool} (${fix.code}) was cancelled by the person who asked. Nothing ran.`,
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
      text: `You have reached today's limit of ${limits.fixesPerUserPerDay} changes in this group. Nothing was run.`,
    });
    return 'refused';
  }
  // the claim: of two confirms racing, one moves the row and runs it
  const claimed = await decideFix(fix.id, 'ran', now);
  if (!claimed) return 'unknown';
  await record('fix_confirmed', fix, null);
  return runFix(room, fix, limits.responseMaxBytes, input.conversationId);
}

async function runFix(
  room: RoomRow,
  fix: FixRow,
  maxBytes: number,
  conversationId: string,
): Promise<'ran' | 'failed'> {
  const api = await activeSupportApi(room.projectId);
  const args = (fix.args ?? {}) as SupportCallArgs;
  const planned = api
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
      fixId: fix.id,
    });
    await postInThread({ room, thread: fix.thread, text: `The change was not run: ${detail}.` });
    await tellSession(
      room,
      fix,
      conversationId,
      `The fix ${fix.tool} (${fix.code}) was confirmed but not run: ${detail}.`,
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
    fixId: fix.id,
  });
  await tellSession(
    room,
    fix,
    posted.conversationId,
    `The fix ${fix.tool} (${fix.code}) ran after the asker confirmed it: answered ${result.status}. What came back: ${JSON.stringify(result.body).slice(0, 2000)}`,
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
      text: `The change ${fix.code} expired before it was confirmed. Nothing was run.`,
    }).catch(() => null);
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: posted?.conversationId ?? null,
      thread: fix.thread,
      kind: 'fix_expired',
      actorKind: 'core',
      tool: fix.tool,
      fixId: fix.id,
      externalId: posted?.messageId ?? null,
    });
  }
}
