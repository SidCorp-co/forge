// The session's acts, each behind the check that the caller is the room's own session: the one
// function both doors (REST and the `forge_support` tool) call, so neither re-implements a rule. A
// support group's acts and an operations room's (`ops-acts.ts`) share the reply and thread reads;
// each kind's own acts are refused in the other's room by name.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { SupportRecordKind } from '@forge/contracts/support';
import type { ChannelRole, ChannelRoute } from '@forge/contracts/support-channel';
import { OPERATIONS_ACTIONS } from '@forge/contracts/support-operations';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import { moveIssue, proposeBuild, proposeDeploy, runCommand } from './ability-acts.js';
import { sessionCaller } from './access.js';
import { announce, inferMember, noteCommonIssue, routeNeed, ruleFromMessage } from './channel.js';
import { sessionChannelView } from './channel-read.js';
import { settleLatency } from './delivery.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import { type OperationsActInput, type OpsOutcome, operationsAct } from './ops-acts.js';
import { no } from './outcome.js';
import { proposeFix, proposeRecord } from './propose.js';
import { search } from './search.js';
import { listTools, readThread, reply, runDiagnose } from './service.js';
import { insertAction, type RoomRow } from './store.js';
import { postInThread } from './thread.js';

export interface SupportCaller {
  userId: string;
  tokenId: string | null | undefined;
  projectId: string;
}

type ToolCall = { thread: string; tool: string; args?: SupportCallArgs | undefined };

export type SupportActInput =
  | OperationsActInput
  | { action: 'search'; query: string }
  | { action: 'thread'; thread: string }
  | { action: 'tools' }
  | { action: 'reply'; thread: string; text: string }
  | ({ action: 'run' } & ToolCall)
  | ({ action: 'propose_fix'; asker: string } & ToolCall)
  | {
      action: 'record';
      thread: string;
      kind: SupportRecordKind;
      title: string;
      summary: string;
      whereSeen?: string | undefined;
      asker?: string | undefined;
    }
  | {
      action: 'move_issue';
      thread: string;
      issue: string;
      to: IssueStatus;
      reason?: string | undefined;
    }
  | { action: 'build'; thread: string; branch: string; title: string; summary: string }
  | { action: 'deploy'; thread: string; target: string }
  | { action: 'command'; thread: string; host: string; command: string }
  | { action: 'channel' }
  | {
      action: 'member';
      member: string;
      roles: ChannelRole[];
      askFor?: string | undefined;
      message: string;
    }
  | { action: 'rule'; thread: string; message: string; text: string }
  | {
      action: 'common_issue';
      threads: string[];
      question: string;
      answer: string;
      feedback?: string | undefined;
    }
  | {
      action: 'route';
      thread: string;
      to: ChannelRoute;
      member?: string | undefined;
      title?: string | undefined;
      text: string;
    }
  | { action: 'announce'; text: string };

export async function supportAct(
  caller: SupportCaller,
  input: SupportActInput,
): Promise<OpsOutcome<unknown>> {
  const room = await sessionCaller(caller);
  const out = isOperation(input)
    ? await operationsAct(room, input)
    : room.kind === 'support' || SHARED.has(input.action)
      ? await act(room, input)
      : no(
          'SUPPORT_NOT_A_SUPPORT_ROOM',
          '/action',
          `${input.action} is a support group's act, and this room is an operations room: its acts are ${OPERATION_ACTIONS.join(', ')}, reply and thread`,
        );
  // an ungranted ability is told in the thread by core itself, naming who can grant it (BC-28)
  if (!out.ok && 'thread' in input) await tellNotGranted(room, input.thread, input.action, out);
  // the session's first post in a thread answers every message of it the session had been handed
  if (out.ok && 'thread' in input && POSTS.has(input.action)) {
    await settleLatency(room.id, input.thread, new Date());
  }
  return out;
}

/** The acts that post in the thread they name. */
const POSTS = new Set<SupportActInput['action']>([
  'reply',
  'run',
  'propose_fix',
  'record',
  'command',
  'deploy',
  'build',
  'route',
]);

/**
 * Post an ability refusal in the thread it was asked in, once per act, and record it: the reply
 * says who can grant it whether or not the session repeats it (REQ-75 r5 BC-28).
 */
async function tellNotGranted(
  room: RoomRow,
  thread: string,
  action: string,
  out: { ok: false; refusals: { code: string; detail: string }[] },
): Promise<void> {
  const refusal = out.refusals.find((r) => r.code === 'SUPPORT_ABILITY_NOT_GRANTED');
  if (!refusal) return;
  const posted = await postInThread({ room, thread, text: refusal.detail }).catch(() => null);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted?.conversationId ?? null,
    thread,
    kind: 'refused',
    actorKind: 'core',
    tool: action,
    output: { code: refusal.code, detail: refusal.detail, posted: Boolean(posted) },
    externalId: posted?.messageId ?? null,
  });
}

/** The acts both kinds of room take: every bound channel keeps its record (REQ-75 r6). */
const SHARED = new Set<SupportActInput['action']>([
  'reply',
  'thread',
  'channel',
  'member',
  'rule',
  'common_issue',
  'route',
  'announce',
]);

const OPERATION_ACTIONS: readonly string[] = OPERATIONS_ACTIONS;
const isOperation = (input: SupportActInput): input is OperationsActInput =>
  OPERATION_ACTIONS.includes(input.action);

type SupportOnlyInput = Exclude<SupportActInput, OperationsActInput>;

async function act(room: RoomRow, input: SupportOnlyInput): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'search':
      return search(room, input.query);
    case 'thread':
      return readThread(room, input.thread);
    case 'tools':
      return listTools(room);
    case 'reply':
      return reply(room, { thread: input.thread, text: input.text });
    case 'run':
      return runDiagnose(room, { thread: input.thread, tool: input.tool, args: input.args ?? {} });
    case 'propose_fix': {
      const out = await proposeFix({
        room,
        thread: input.thread,
        tool: input.tool,
        args: input.args ?? {},
        asker: input.asker,
      });
      return out.ok
        ? { ok: true, value: { fixId: out.fixId, code: out.code, messageId: out.messageId } }
        : out;
    }
    case 'record': {
      const refused = await abilityRefusal(
        room,
        grantsOf(await supportConfigOf(room)),
        'file_items',
      );
      if (refused) return refused;
      const { action: _, ...request } = input;
      const out = await proposeRecord(room, request);
      // nothing is filed yet: the asker confirms in the thread, and the session is told the key
      return out.ok
        ? { ok: true, value: { pending: true, code: out.code, messageId: out.messageId } }
        : out;
    }
    case 'move_issue': {
      const { action: _, ...request } = input;
      return moveIssue(room, request);
    }
    case 'build': {
      const { action: _, ...request } = input;
      return proposeBuild(room, request);
    }
    case 'deploy':
      return proposeDeploy(room, { thread: input.thread, target: input.target });
    case 'command':
      return runCommand(room, { thread: input.thread, host: input.host, command: input.command });
    case 'channel':
      return { ok: true, value: await sessionChannelView(room.projectId, room.rid) };
    case 'member': {
      const { action: _, ...request } = input;
      return inferMember(room, request);
    }
    case 'rule': {
      const { action: _, ...request } = input;
      return ruleFromMessage(room, request);
    }
    case 'common_issue': {
      const { action: _, ...request } = input;
      return noteCommonIssue(room, request);
    }
    case 'route': {
      const { action: _, ...request } = input;
      return routeNeed(room, request);
    }
    case 'announce':
      return announce(room, { text: input.text });
  }
}
