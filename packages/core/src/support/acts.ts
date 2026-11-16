// The session's acts, each behind the check that the caller is the room's own session: the one
// function both doors (REST and the `forge_support` tool) call, so neither re-implements a rule. A
// support group's acts and an operations room's (`ops-acts.ts`) share the reply and thread reads;
// each kind's own acts are refused in the other's room by name.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type {
  SupportApproveRequest,
  SupportDecideRequest,
  SupportOwnerActRequest,
  SupportOwnerConsentRequest,
  SupportOwnerSignInRequest,
  SupportPromiseRequest,
  SupportRecordKind,
} from '@forge/contracts/support';
import type {
  ChannelRole,
  ChannelRoute,
  SupportAnswerQuestionRequest,
  SupportForgeActRequest,
  SupportReleaseDecisionRequest,
} from '@forge/contracts/support-channel';
import type { SupportAskMasterRequest } from '@forge/contracts/support-master-ask';
import { OPERATIONS_ACTIONS } from '@forge/contracts/support-operations';
import type { SupportAuditRequest } from '@forge/contracts/support-reply-audit';
import type { SupportTechnicalRequest } from '@forge/contracts/support-technical';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import {
  moveIssue,
  proposeBuild,
  proposeDeploy,
  readDeployment,
  runCommand,
} from './ability-acts.js';
import { type RoomHint, sessionCaller } from './access.js';
import { deniedActRefusal } from './act-deny.js';
import { askerFacts } from './asker-read.js';
import { announce, inferMember, noteCommonIssue, routeNeed, ruleFromMessage } from './channel.js';
import { sessionChannelView } from './channel-read.js';
import { checkResult } from './checks.js';
import { settleLatency } from './delivery.js';
import { agreeTo } from './fixes.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import { readImage } from './images.js';
import { endLastResortWait } from './last-resort.js';
import { noteReleaseRead, unreadLiveClaim } from './live-claims.js';
import { askMaster } from './master-ask.js';
import { type OperationsActInput, type OpsOutcome, operationsAct } from './ops-acts.js';
import { runRead } from './ops-read.js';
import { no } from './outcome.js';
import { ownerAct } from './owner-act.js';
import { attachApproval } from './owner-approves.js';
import { askOwner } from './owner-ask.js';
import { ownerConsent } from './owner-consent.js';
import { ownerForgeAct } from './owner-forge-act.js';
import { raiseOwed } from './owner-owed-raise.js';
import { startOwnerSignIn } from './owner-sign-in.js';
import { readProjectFacts } from './project-read.js';
import { makePromise } from './promise.js';
import { proposeFix, proposeRecord } from './propose.js';
import { answerHandedQuestion } from './question-task.js';
import { decideReleaseFromMessage } from './release-decision.js';
import { auditReply } from './reply-audit/audit.js';
import { decideRouting } from './routing.js';
import { search } from './search.js';
import { listTools, readThread, reply, runDiagnose, staySilent } from './service.js';
import { inFlightOf } from './shared-picture.js';
import { linkMember } from './speaker-link.js';
import { insertAction, type RoomRow } from './store.js';
import { raiseTechnical } from './technical-channel.js';
import { TOP_LEVEL } from './thread.js';
import { noteSessionAct } from './turn-acts.js';
import { turnOfRequest } from './turn-of-act.js';

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
  | { action: 'reply'; thread: string; text: string; why?: string | undefined }
  | { action: 'silent'; thread: string; message?: string | undefined; reason: string }
  | ({ action: 'decide' } & SupportDecideRequest)
  | ({ action: 'approve' } & SupportApproveRequest)
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
      separate?: true | undefined;
    }
  | {
      action: 'move_issue';
      thread: string;
      message: string;
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
  | { action: 'image'; message: string; n?: number | undefined }
  | ({ action: 'promise' } & SupportPromiseRequest)
  | ({ action: 'owner_consent' } & SupportOwnerConsentRequest)
  | ({ action: 'owner_act' } & SupportOwnerActRequest)
  | ({ action: 'owner_sign_in' } & SupportOwnerSignInRequest)
  | ({ action: 'release_decision' } & SupportReleaseDecisionRequest)
  | ({ action: 'ask_master' } & SupportAskMasterRequest)
  | { action: 'in_flight'; thread: string }
  | { action: 'raise_owed'; thread: string; text: string }
  | { action: 'asker'; thread: string; message: string }
  | ({ action: 'technical' } & SupportTechnicalRequest)
  | ({ action: 'audit' } & SupportAuditRequest)
  | ({ action: 'owner_forge_act' } & SupportForgeActRequest)
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
  // any act, a read or a refused one included, shows the turn did something (ISS-1007)
  if (room.sessionId) noteSessionAct(room.sessionId);
  // the turn the act is in: its own row, since the session holds one token across turns (ISS-1202)
  const { turnId } = await turnOfRequest();
  // an act the project keeps from its room agents goes to its technical channel instead (ISS-1243)
  const denied = await deniedActRefusal(room, input);
  if (denied) return denied;
  const out = isOperation(input)
    ? await operationsAct(room, input)
    : room.kind === 'support' || room.kind === 'agent' || SHARED.has(input.action)
      ? await act(room, input, turnId)
      : no(
          'SUPPORT_NOT_A_SUPPORT_ROOM',
          '/action',
          `${input.action} is a support group's and a channel agent's act, and this room is an operations room: its acts are ${OPERATION_ACTIONS.join(', ')}, reply and thread`,
        );
  // a release read is what a claim of what is live is held to, in this turn alone (ISS-1123)
  if (out.ok) await noteReleaseRead(room, turnId, input);
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
  'feedback',
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
  'silent',
  // every room's agent records which project a message concerns and what it does with it (ISS-1243)
  'decide',
  'thread',
  'channel',
  'member',
  'rule',
  'common_issue',
  'route',
  'announce',
  'ask_owner',
  // a member's picture reads the same in an operations room as in a support group (ISS-1010)
  'image',
  // any room's agent asks a master, and reads what the masters hold for its thread (ISS-1243)
  'ask_master',
  'in_flight',
  // what waits on the owner, raised in the technical channel (ISS-1243)
  'raise_owed',
  // every room agent raises what it needs in its project's technical channel (ISS-1243)
  'technical',
  // every room agent audits its own reply right after posting it (ISS-1250)
  'audit',
  // and reads who wrote a message and the thread around it (ISS-1250)
  'asker',
]);

const OPERATION_ACTIONS: readonly string[] = OPERATIONS_ACTIONS;
const isOperation = (input: SupportActInput): input is OperationsActInput =>
  OPERATION_ACTIONS.includes(input.action);

type SupportOnlyInput = Exclude<SupportActInput, OperationsActInput>;

async function act(
  room: RoomRow,
  input: SupportOnlyInput,
  turn: string | null | undefined,
): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'search':
      return search(room, input.query, input.project);
    case 'thread':
      return readThread(room, input.thread);
    case 'tools':
      return listTools(room);
    case 'reply':
      return reply(room, { thread: input.thread, text: input.text, why: input.why, turn });
    case 'silent':
      return staySilent(room, input);
    case 'decide': {
      const { action: _, ...request } = input;
      return decideRouting(room, request);
    }
    case 'approve': {
      const { action: _, ...request } = input;
      return attachApproval(room, request);
    }
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
    case 'announce': {
      const unread = await unreadLiveClaim(room, {
        thread: TOP_LEVEL,
        conversationId: null,
        text: input.text,
        turn,
        tool: 'announce',
      });
      return unread ?? announce(room, { text: input.text });
    }
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
    case 'image':
      return readImage(room, { message: input.message, n: input.n });
    case 'promise': {
      const { action: _, ...request } = input;
      return makePromise(room, request);
    }
    case 'owner_consent': {
      const { action: _, ...request } = input;
      return ownerConsent(room, request);
    }
    case 'owner_act':
      return ownerAct(room, {
        thread: input.thread,
        message: input.message,
        tool: input.tool,
        args: input.args,
        agreement: input.agreement,
      });
    case 'release_decision': {
      const { action: _, ...request } = input;
      return decideReleaseFromMessage(room, request);
    }
    case 'ask_master': {
      const { action: _, ...request } = input;
      return askMaster(room, request, turn);
    }
    case 'in_flight':
      return inFlightOf(room, input.thread);
    case 'raise_owed':
      return raiseOwed(room, { thread: input.thread, text: input.text });
    case 'technical': {
      const { action: _, ...request } = input;
      return raiseTechnical(room, request);
    }
    case 'audit': {
      const { action: _, ...request } = input;
      return auditReply(room, request);
    }
    case 'owner_forge_act': {
      const { action: _, ...request } = input;
      return ownerForgeAct(room, request);
    }
    case 'asker':
      return askerFacts(room, { thread: input.thread, message: input.message });
    case 'owner_sign_in':
      return startOwnerSignIn(room, {
        thread: input.thread,
        ...(input.product !== undefined ? { product: input.product } : {}),
      });
  }
}
