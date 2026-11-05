// Proposing a change its asker agrees to (REQ-75 BC-13, BC-14; ISS-845): a fix through the product
// API, a filing of Feedback, or a build, a deploy or a host command. Core records the proposal and
// posts nothing: the session asks the person in its own words, and what becomes of it once they
// answer is `fixes.ts:agreeTo`'s. The owner is never asked about his own request (ISS-915): the
// session cites it with agree at once.

import { SUPPORT_FIX_TTL_MS } from '@forge/contracts/support';
import {
  planSupportCall,
  type SupportCallArgs,
  supportApisOf,
} from '../integrations/support-api/index.js';
import { changeWaitsOnRole, requestIsConsent, whoConfirms } from './confirm-role.js';
import { grantsOf, isNamedOwner, supportConfigOf } from './grants.js';
import { namedProject } from './ops-scope.js';
import { knownThread, threadUnknown } from './outcome.js';
import type { RecordRequest } from './record.js';
import { type Refusal, refusalOf } from './refusals.js';
import { mintConfirmCode } from './rules.js';
import { insertAction, insertFix, type ProposalRow, type RoomRow, threadMembers } from './store.js';
import { noteInThread } from './thread.js';

/** What the session is handed for a proposal: its handle, whom it waits on, and until when. */
export interface Proposed {
  pending: true;
  proposal: string;
  waitsOn: string;
  expiresAt: string;
  next: string;
}

export type ProposeOutcome = { ok: true; value: Proposed } | { ok: false; refusals: Refusal[] };

type Member = { key: string; label: string | null };

/** The thread's member a change waits on: `asker` when named, else the thread's first writer. */
export async function askerOf(
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
 * Put a change before its asker: a handle minted and the proposal recorded, nothing posted. The
 * session asks in its own words; nothing happens until it cites the person's agreeing message
 * (`agreeTo`); unanswered, it expires (`expireSupportFixes`).
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
  /** Who agrees, as the session is told it; the asker when absent. */
  waitsOn?: string;
  args: Record<string, unknown>;
}): Promise<ProposeOutcome> {
  const { room, asker } = input;
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
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
  if (!fix) throw new Error('support: five handles in a row were taken; no change was proposed');
  const waitsOn = input.waitsOn ?? `@${asker.label ?? asker.key}`;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'fix_proposed',
    actorKind: 'session',
    tool: fix.tool,
    input: input.args,
    output: { code: fix.code, asker: asker.key, expiresAt: fix.expiresAt.toISOString() },
    proposalId: fix.id,
  });
  await noteInThread(
    conversationId,
    `Proposed: ${changeName(fix)}, waiting on ${waitsOn} to agree (${fix.code}).`,
  );
  return {
    ok: true,
    value: {
      pending: true,
      proposal: fix.code,
      waitsOn,
      expiresAt: fix.expiresAt.toISOString(),
      next: (await ownRequestConsents(room, fix, asker))
        ? `Nothing was posted. @${asker.label ?? asker.key} asked for this themselves, and in this room their own request is their agreement: call agree { thread, proposal: "${fix.code}", message: <the id of their message asking for it> } now, and ask them nothing.`
        : `Nothing was posted. Ask ${waitsOn} in your own words, in this thread. When they answer, call agree { thread, proposal: "${fix.code}", message: <their message id>, decision?: "decline" }.`,
    },
  };
}

/**
 * Whether the asker's own request will be their agreement to this proposal: an asker the room lets
 * confirm (ISS-953), or the owner the binding names asking for a filing (ISS-954).
 */
async function ownRequestConsents(
  room: RoomRow,
  fix: ProposalRow,
  asker: { key: string; label: string | null },
): Promise<boolean> {
  const grants = grantsOf(await supportConfigOf(room));
  if (fix.kind === 'filing' && isNamedOwner(grants, asker.key)) return true;
  return requestIsConsent(room, grants, asker);
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
  const apis = await supportApisOf(room.projectId);
  if (apis.bindings.length === 0) {
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
  const planned = planSupportCall({ apis, name: input.tool, kind: 'fix', args: input.args });
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
  // in a channel agent's group a fix waits on a member whose role allows it, not on its asker (BC-10)
  const confirmers = changeWaitsOnRole(room)
    ? whoConfirms(room, grantsOf(await supportConfigOf(room)))
    : undefined;
  return offerChange({
    room,
    thread: input.thread,
    asker: asked.asker,
    change: { kind: 'fix', tool: planned.plan.tool.name },
    ...(confirmers ? { waitsOn: confirmers } : {}),
    args: input.args,
  });
}

/**
 * Record what needs code as Feedback, once its asker agrees (REQ-75 BC-14; REQ-30 BC-4): nothing is
 * filed until the session cites the asker's agreeing message; unanswered, it expires as a fix does.
 */
export async function proposeRecord(
  room: RoomRow,
  input: RecordRequest & { asker?: string | undefined },
): Promise<ProposeOutcome> {
  const asked = await askerOf(room, input.thread, input.asker);
  if (!asked.ok) return asked;
  // a project outside the agent's set is refused now, before the asker is asked anything (ISS-874)
  const target = await namedProject(room, input.project);
  if (!target.ok) return target;
  const { asker: _asker, ...request } = input;
  return offerChange({
    room,
    thread: input.thread,
    asker: asked.asker,
    change: { kind: 'filing' },
    args: request,
  });
}

/** What did not happen to a change nobody agreed to, as the session is told it. */
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
