// The session's acts, each behind the check that the caller is the room's own session: the one
// function both doors (REST and the `forge_support` tool) call, so neither re-implements a rule. A
// support group's acts and an operations room's (`ops-acts.ts`) share the reply and thread reads;
// each kind's own acts are refused in the other's room by name.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { SupportRecordKind } from '@forge/contracts/support';
import type {
  ChannelRole,
  ChannelRoute,
  SupportAnswerQuestionRequest,
} from '@forge/contracts/support-channel';
import { OPERATIONS_ACTIONS } from '@forge/contracts/support-operations';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import {
  moveIssue,
  proposeBuild,
  proposeDeploy,
  readDeployment,
  runCommand,
} from './ability-acts.js';
import { type RoomHint, sessionCaller } from './access.js';
import { announce, inferMember, noteCommonIssue, routeNeed, ruleFromMessage } from './channel.js';
import { sessionChannelView } from './channel-read.js';
import { checkResult } from './checks.js';
import { settleLatency } from './delivery.js';
import { agreeTo } from './fixes.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import { endLastResortWait } from './last-resort.js';
import { type OperationsActInput, type OpsOutcome, operationsAct } from './ops-acts.js';
import { runRead } from './ops-read.js';
import { no } from './outcome.js';
import { askOwner } from './owner-ask.js';
import { readProjectFacts } from './project-read.js';
import { proposeFix, proposeRecord } from './propose.js';
import { answerHandedQuestion } from './question-task.js';
import { search } from './search.js';
import { listTools, readThread, reply, runDiagnose } from './service.js';
import { linkMember } from './speaker-link.js';
import { insertAction, type RoomRow } from './store.js';

export interface SupportCaller {
  userId: string;
  tokenId: string | null | undefined;
  projectId: string;
}

type ToolCall = { thread: string; tool: string; args?: SupportCallArgs | undefined };

export type SupportActInput =
  | OperationsActInput
  | { action: 'search'; query: string; project?: string | undefined }
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
      project?: string | undefined;
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
  | { action: 'deployment'; target: string }
  | { action: 'project'; project?: string | undefined }
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
  | { action: 'announce'; text: string }
  | {
      action: 'ask_owner';
      thread: string;
      question: string;
      record?: string | undefined;
      forgeQuestion?: string | undefined;
      opener?: string | undefined;
    }
  | ({ action: 'answer_question' } & SupportAnswerQuestionRequest)
  | { action: 'check_result'; check: string; finding: string | null }
  | {
      action: 'agree';
      thread: string;
      proposal: string;
      message: string;
      decision?: 'agree' | 'decline' | undefined;
    }
  | { action: 'link'; thread: string; member: string }
  | {
      action: 'read';
      name: string;
      args?: Record<string, string | number> | undefined;
      thread?: string | undefined;
      check?: string | undefined;
    };

/**
 * One act of a room's session. `rid` names the group a channel agent acts in where the act names no
 * thread or message of it (REQ-77); a session answering one group never needs it.
 */
export async function supportAct(
  caller: SupportCaller,
  input: SupportActInput,
  where: { rid?: string | undefined } = {},
): Promise<OpsOutcome<unknown>> {
  const room = await sessionCaller(caller, hintOf(input, where.rid));
  const out = isOperation(input)
    ? await operationsAct(room, input)
    : room.kind === 'support' || room.kind === 'agent' || SHARED.has(input.action)
      ? await act(room, input)
      : no(
          'SUPPORT_NOT_A_SUPPORT_ROOM',
          '/action',
          `${input.action} is a support group's and a channel agent's act, and this room is an operations room: its acts are ${OPERATION_ACTIONS.join(', ')}, reply and thread`,
        );
  // a refusal, an ungranted ability's included, is the session's to read and say in its own words:
  // core posts nothing in the room (ISS-845), and records the ungranted one (BC-28); a read records
  // every refusal of its own (`ops-read.ts`)
  if (!out.ok && 'thread' in input && input.action !== 'read' && input.thread) {
    await recordNotGranted(room, input.thread, input.action, out);
  }
  // the session's first post in a thread answers every message of it the session had been handed,
  // and ends the wait a last-resort line told the thread of (ISS-977)
  if (out.ok && 'thread' in input && input.thread && POSTS.has(input.action)) {
    await settleLatency(room.id, input.thread, new Date());
    await endLastResortWait(room, input.thread);
  }
  return out;
}

/** The acts that read the same from any group of a channel agent: its grant and project are shared. */
const ANY_ROOM = new Set<SupportActInput['action']>([
  'search',
  'tools',
  'deployment',
  'project',
  'read',
  // the tracker reads the same from any group, over every project the agent follows (ISS-874)
  'projects',
  'issues',
  'releases',
  'requirements',
]);

/** What an act names that places it in one group of a channel agent's (REQ-77). */
function hintOf(input: SupportActInput, rid: string | undefined): RoomHint {
  const named = input as {
    thread?: unknown;
    threads?: unknown;
    message?: unknown;
    check?: unknown;
  };
  const thread =
    typeof named.thread === 'string'
      ? named.thread
      : typeof named.check === 'string'
        ? named.check
        : Array.isArray(named.threads) && typeof named.threads[0] === 'string'
          ? named.threads[0]
          : undefined;
  return {
    rid,
    thread,
    message: typeof named.message === 'string' ? named.message : undefined,
    anyRoom: ANY_ROOM.has(input.action),
  };
}

/** The acts that post in the thread they name: each posts the session's own words. */
const POSTS = new Set<SupportActInput['action']>(['reply', 'route', 'ask_owner']);

/** An ability refusal, recorded once per act on the thread it was asked in; nothing is posted. */
async function recordNotGranted(
  room: RoomRow,
  thread: string,
  action: string,
  out: { ok: false; refusals: { code: string; detail: string }[] },
): Promise<void> {
  const refusal = out.refusals.find((r) => r.code === 'SUPPORT_ABILITY_NOT_GRANTED');
  if (!refusal) return;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: 'refused',
    actorKind: 'core',
    tool: action,
    output: { code: refusal.code, detail: refusal.detail, posted: false },
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
  'ask_owner',
]);

const OPERATION_ACTIONS: readonly string[] = OPERATIONS_ACTIONS;
const isOperation = (input: SupportActInput): input is OperationsActInput =>
  OPERATION_ACTIONS.includes(input.action);

type SupportOnlyInput = Exclude<SupportActInput, OperationsActInput>;

async function act(room: RoomRow, input: SupportOnlyInput): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'search':
      return search(room, input.query, input.project);
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
      return out;
    }
    case 'record': {
      const refused = await abilityRefusal(
        room,
        grantsOf(await supportConfigOf(room)),
        'file_items',
      );
      if (refused) return refused;
      const { action: _, ...request } = input;
      // nothing is filed yet: the session asks, and `agree` files it on the asker's plain yes
      return proposeRecord(room, request);
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
    case 'deployment':
      return readDeployment(room, { target: input.target });
    case 'project':
      return readProjectFacts(room, input.project);
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
    case 'ask_owner': {
      const { action: _, ...request } = input;
      return askOwner(room, request);
    }
    case 'answer_question': {
      const { action: _, ...request } = input;
      return answerHandedQuestion(room, request);
    }
    case 'check_result':
      return checkResult(room, { check: input.check, finding: input.finding });
    case 'agree': {
      const { action: _, ...request } = input;
      return agreeTo(room, request);
    }
    case 'link':
      return linkMember(room, { thread: input.thread, member: input.member });
    case 'read': {
      const { action: _, ...request } = input;
      return runRead(room, request);
    }
  }
}
