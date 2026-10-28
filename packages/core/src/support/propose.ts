// Proposing a change its asker confirms (REQ-75 BC-13, BC-14): a fix through the product API, or a
// filing of Feedback. The thread is shown what it does with the buttons that write `confirm` and
// `cancel`; what becomes of it is `fixes.ts`'s.

import { SUPPORT_FIX_TTL_MS } from '@forge/contracts/support';
import type { RocketChatButtonAttachment } from '../integrations/rocketchat/index.js';
import {
  activeSupportApi,
  planCall,
  type SupportCallArgs,
} from '../integrations/support-api/index.js';
import { type RecordRequest, threadLink } from './record.js';
import { type Refusal, refusalOf } from './refusals.js';
import { confirmPrompt, mintConfirmCode, recordPrompt } from './rules.js';
import { insertAction, insertFix, type ProposalRow, type RoomRow, threadMembers } from './store.js';
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

type Member = { key: string; label: string | null };

/** The thread's member a change waits on: `asker` when named, else the thread's first writer. */
async function askerOf(
  room: RoomRow,
  thread: string,
  asker: string | undefined,
): Promise<{ ok: true; asker: Member } | { ok: false; refusals: Refusal[] }> {
  const members = await threadMembers(room.id, thread);
  if (members.length === 0) {
    return {
      ok: false,
      refusals: [
        refusalOf(
          'SUPPORT_THREAD_UNKNOWN',
          '/thread',
          `no member has written in thread ${thread} of this group`,
        ),
      ],
    };
  }
  const found = asker === undefined ? members[0] : members.find((m) => m.key === asker);
  if (found) return { ok: true, asker: found };
  return {
    ok: false,
    refusals: [
      refusalOf(
        'SUPPORT_ASKER_NOT_IN_THREAD',
        '/asker',
        `account ${asker} has not written in this thread; the asker is one of ${members.map((m) => `${m.key} (${m.label ?? 'no name'})`).join(', ')}`,
      ),
    ],
  };
}

/**
 * Put a change before its asker: a code minted, the thread shown what it does with the buttons
 * that write `confirm` and `cancel`, and the proposal recorded. Nothing happens until that account
 * confirms (`answerConfirm`); unconfirmed, it expires (`expireSupportFixes`).
 */
export async function offerChange(input: {
  room: RoomRow;
  thread: string;
  asker: Member;
  /**
   * A fix names its granted tool; a filing names none; a build, a deploy and a host change wait on
   * the room's confirmers rather than on the asker (`waitsOn`).
   */
  change: { kind: 'fix'; tool: string } | { kind: 'filing' | 'build' | 'deploy' | 'command' };
  /** Who confirms, as the session's note says it; the asker when absent. */
  waitsOn?: string;
  args: Record<string, unknown>;
  prompt: (code: string) => string;
}): Promise<ProposeOutcome> {
  const { room, asker } = input;
  const now = new Date();
  let fix: ProposalRow | null = null;
  for (let attempt = 0; attempt < 5 && !fix; attempt++) {
    fix = await insertFix({
      roomId: room.id,
      projectId: room.projectId,
      thread: input.thread,
      kind: input.change.kind,
      tool: input.change.kind === 'fix' ? input.change.tool : null,
      args: input.args,
      askerKey: asker.key,
      askerLabel: asker.label,
      code: mintConfirmCode(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + SUPPORT_FIX_TTL_MS),
    });
  }
  if (!fix) throw new Error('support: five codes in a row were taken; no change was proposed');
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: input.prompt(fix.code),
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
    proposalId: fix.id,
  });
  await noteInThread(
    posted.conversationId,
    `Proposed: ${changeName(fix)}, waiting on ${input.waitsOn ?? asker.label ?? asker.key} to confirm ${fix.code}.`,
  );
  return { ok: true, fixId: fix.id, code: fix.code, messageId: posted.messageId };
}

export async function proposeFix(input: {
  room: RoomRow;
  thread: string;
  tool: string;
  args: SupportCallArgs;
  asker: string;
}): Promise<ProposeOutcome> {
  const { room } = input;
  const asked = await askerOf(room, input.thread, input.asker);
  if (!asked.ok) return asked;
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
  return offerChange({
    room,
    thread: input.thread,
    asker: asked.asker,
    change: { kind: 'fix', tool: planned.plan.tool.name },
    args: input.args,
    prompt: (code) =>
      confirmPrompt({
        askerLabel: asked.asker.label,
        summary: planned.plan.tool.summary,
        args: input.args,
        code,
      }),
  });
}

/**
 * Record what needs code as Feedback, once its asker agrees (REQ-75 BC-14; REQ-30 BC-4): the
 * thread is told what would be filed, of which kind, with the thread's link, and nothing is filed
 * until that account confirms; unconfirmed, it expires as a fix does.
 */
export async function proposeRecord(
  room: RoomRow,
  input: RecordRequest & { asker?: string | undefined },
): Promise<ProposeOutcome> {
  const asked = await askerOf(room, input.thread, input.asker);
  if (!asked.ok) return asked;
  const { asker: _asker, ...request } = input;
  const link = await threadLink(room, input.thread);
  return offerChange({
    room,
    thread: input.thread,
    asker: asked.asker,
    change: { kind: 'filing' },
    args: request,
    prompt: (code) =>
      recordPrompt({
        askerLabel: asked.asker.label,
        kind: input.kind,
        title: input.title,
        link,
        code,
      }),
  });
}

/** What did not happen to a change nobody confirmed. */
export const nothingDone = (fix: Pick<ProposalRow, 'kind'>) =>
  fix.kind === 'filing'
    ? 'Nothing was recorded.'
    : fix.kind === 'deploy'
      ? 'Nothing was deployed.'
      : fix.kind === 'build'
        ? 'Nothing was pushed.'
        : 'Nothing was run.';

/** What a change is, in the words the thread and the session are told. */
export function changeName(fix: Pick<ProposalRow, 'kind' | 'tool' | 'args'>): string {
  if (fix.kind === 'fix') return `the fix ${fix.tool}`;
  const args = (fix.args ?? {}) as Record<string, unknown>;
  if (fix.kind === 'command')
    return `the command \`${String(args.command)}\` on ${String(args.host)}`;
  if (fix.kind === 'deploy') return `the deploy of ${String(args.label ?? args.target)}`;
  if (fix.kind === 'build') return `the build of ${String(args.branch)}`;
  return `the filing "${String((fix.args as { title?: unknown } | null)?.title ?? '')}"`;
}
