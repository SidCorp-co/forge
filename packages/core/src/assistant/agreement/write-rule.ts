// The one rule every write a chat credential attempts meets (REQ-30 BC-4, workflow chat-turn r3
// step hold): the Assistant's turn token and its own tools, and an Agent session's turn token over
// REST and /mcp. Holding is the default, not an opt-in: a write is HELD as a proposal the person
// sees as a confirm card where a hold names it, PASSED only where the list below names it as not a
// business write, and otherwise REFUSED by name. So a write route or tool added later, which nobody
// remembered to name, is refused for a chat rather than let through.
//
// Three doors read this file and nothing else decides: the REST admission every PAT request passes
// (`rest-hold.ts:admitChatRestWrite`), the /mcp tool call (`rest-hold.ts:refuseChatToolWrite`) and
// the Assistant turn's gate (`turn-gate.ts`). A REST route and the tool that is its twin are named
// in one entry, so the two doors cannot drift apart.
//
// Holding is not chosen where no card can carry the write: a project or an issue deleted, a secret,
// who may act on a project, knowledge that reaches every prompt, a requirement's sign-off, a design,
// a document to another project's team, a pipeline, job, deploy or release act. Those are refused
// from chat by name, saying where the person does it, and a card for them is never offered.
//
// Ruled 2026-10-09 (ISS-439): a box session answering no room (the Agents screen, a Rocket.Chat
// escalation) is not held and writes as before (`rest-hold.ts`); and a typed yes never counts as
// agreement, so only the press on the card writes a held call.

import { CHAT_ACT_TOOL } from '@forge/contracts/chat-acts';
import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import { UI_ACTION_NAMES, UI_ACTIONS } from '@forge/contracts/ui-actions';
import type { ToolGrantEntry } from '../../lib/tool.js';
import { HISTORY_TOOL_NAME, QUOTE_CONTEXT_TOOL_NAME } from '../chat-room/context.js';
import { TRANSCRIPT_SEARCH_TOOL_NAME } from '../tools/transcript-search-tool.js';
import { isRecordPreview, isWriteCall } from '../turn-writes.js';
import { kindOfToolCall } from './summary.js';

export type ChatWriteVerdict =
  | { readonly verdict: 'read' }
  | { readonly verdict: 'hold'; readonly kind: ChatProposalKind }
  | { readonly verdict: 'pass'; readonly why: string }
  | { readonly verdict: 'route-refuses'; readonly why: string }
  | {
      readonly verdict: 'refuse';
      readonly family: string;
      readonly why: string;
      readonly where: string;
    };

/** A REST write as the admission reads it: the route pattern the request matched, not its path. */
export interface ChatRestWrite {
  readonly method: string;
  /** The pattern the serving route was registered under, e.g. `/api/issues/:id/transition`. */
  readonly route: string;
  /** The kind the route's own hold names (`middleware/chat-write-hold.ts:holdChatWrite`), or null. */
  readonly heldAs: ChatProposalKind | null;
}

/** One call not a business write: a REST route (`METHOD /pattern`) and the tools that are its twins. */
interface NotABusinessWrite {
  readonly why: string;
  readonly rest: readonly string[];
  readonly tools: readonly string[];
}

/**
 * The one list of calls a chat credential makes that are not a business write, each with why. A
 * call named here passes; a write named nowhere is refused. Reads by method (GET) and tools whose
 * declared grant is a read never reach this list.
 */
export const NOT_A_BUSINESS_WRITE: readonly NotABusinessWrite[] = [
  {
    why: 'a search: a read sent as a POST, which writes nothing',
    rest: ['POST /api/memory/search', 'POST /api/projects/:id/knowledge/search'],
    tools: [],
  },
  {
    why: 'a preview: it renders what a write would say and writes nothing',
    rest: ['POST /api/body/preview', 'POST /api/projects/:id/feedback/:fb/messages/preview'],
    tools: [],
  },
  {
    why: 'a report query or template run, kept so the room can cite it; it changes no record the project works from',
    rest: [
      'POST /api/projects/:id/report-queries/:queryId/runs',
      'POST /api/projects/:id/report-templates/:templateId/runs',
      'POST /api/projects/:id/report-templates/:templateId/narrative',
    ],
    tools: [],
  },
  {
    why: 'a computation over the report runs this turn made, on a sandbox; its result is kept for the room and changes no record',
    rest: ['POST /api/projects/:id/executions'],
    tools: ['forge_compute'],
  },
  {
    why: "a block the chat draws into its own room: the chat's own message, never a record",
    rest: ['POST /api/conversations/:id/blocks'],
    tools: ['forge_show'],
  },
  {
    why: "which contracts the session's repository paths call: a read, noted on the asking session",
    rest: ['POST /api/projects/:id/contract-context'],
    tools: [],
  },
  {
    why: 'a suggestion the BA offers: it changes nothing until a person accepts it on the requirement page',
    rest: [],
    tools: ['ba_suggest', 'ba_suggest_requirement'],
  },
  {
    why: 'an ask to the person in this room, through the questionnaire card',
    rest: [],
    tools: ['ba_send_questionnaire', 'ba_ask_clarification'],
  },
  {
    why: "it moves the person's own screen, or offers them a button they press as themselves; it writes nothing",
    rest: [],
    tools: [...UI_ACTION_NAMES.map((n) => UI_ACTIONS[n].wire), CHAT_ACT_TOOL],
  },
  {
    why: "a read of this room's own past",
    rest: [],
    tools: [HISTORY_TOOL_NAME, QUOTE_CONTEXT_TOOL_NAME, TRANSCRIPT_SEARCH_TOOL_NAME],
  },
  {
    why: 'it hands this turn to a box session, whose own writes meet this rule',
    rest: [],
    tools: ['escalate'],
  },
];

/**
 * Writes whose own route refuses every chat credential by a name of its own, so the rule leaves the
 * refusal to it rather than answering in its place: a chat files no issue, and no chat credential
 * presses a card for the person.
 */
export const REFUSED_AT_THE_ROUTE: Readonly<Record<string, string>> = {
  'POST /api/projects/:id/issues':
    'the issue kernel refuses every chat credential CHAT_FILES_FEEDBACK_NOT_ISSUES, whatever route it takes (issues/create-service.ts)',
  'POST /api/conversations/:id/proposals/:pid/agree':
    'the agreement door refuses every chat credential CHAT_AGREEMENT_DOOR: only the person presses Record it (agreement-door.ts)',
  'POST /api/conversations/:id/proposals/:pid/decline':
    'the agreement door refuses every chat credential CHAT_AGREEMENT_DOOR: only the person presses Decline (agreement-door.ts)',
};

/**
 * The tool that writes only through other doors: the forge CLI runs under the turn token, so each
 * request it sends meets this rule's REST half. Its forms that write are held here first
 * (`turn-writes.ts:isWriteCall`), so the card shows the CLI call rather than its requests.
 */
export const DELEGATES_TO_REST: Readonly<Record<string, string>> = {
  forge:
    'the forge CLI writes only through core REST under the turn token, where this rule decides each request',
};

interface RefusedFamily {
  readonly family: string;
  readonly why: string;
  readonly where: string;
  /** Matched against `METHOD /pattern`. */
  readonly rest: readonly RegExp[];
  readonly tools: readonly string[];
}

/** Families no confirm card carries: refused from chat by name. A write in none is refused too. */
export const REFUSED_FROM_CHAT: readonly RefusedFamily[] = [
  {
    family: 'project deletion',
    why: 'deleting a project removes it and everything in it',
    where: "on the project's settings page",
    rest: [/^DELETE \/api\/projects\/:id$/],
    tools: [],
  },
  {
    family: 'issue deletion',
    why: 'deleting an issue removes it and its record',
    where: "on the issue's page",
    rest: [/^DELETE \/api\/issues\/:id$/],
    tools: [],
  },
  {
    family: 'secret write',
    why: "a secret's value must never pass through a chat or a card",
    where: "in the project's settings",
    rest: [/secret/i, /git-credential/],
    tools: [],
  },
  {
    family: 'membership change',
    why: 'who may act on a project is decided by its owner',
    where: "on the project's members page",
    rest: [/\/members\b/, /\/invitations?\b/, /^\S+ \/api\/memberships\b/, /\/agents\b/],
    tools: [],
  },
  {
    family: 'knowledge entry',
    why: 'a knowledge entry can reach every prompt this project runs',
    where: 'on the Knowledge page, or with forge knowledge at a terminal',
    rest: [/^\S+ \/api\/projects\/:id\/knowledge\b/],
    tools: ['forge_knowledge', 'forge_memory'],
  },
  {
    family: 'requirement sign-off',
    why: "a requirement's sign-off and lifecycle are decided by a person on its page",
    where: "on the requirement's page",
    rest: [
      /\/requirements\/:req\/(agree|accept|promote|drop|defer|undefer|repin|assistant)$/,
      /\/requirements\/:req\/revisions\/:n\/(propose|accept|return)$/,
    ],
    tools: [],
  },
  {
    family: 'design change',
    why: 'a design is drawn, proposed and decided by its owner',
    where: "on the design's page",
    rest: [/^\S+ \/api\/projects\/:id\/workflows\b/],
    tools: [],
  },
  {
    family: 'channel document',
    why: "it speaks to another project's team, which a card in this room cannot answer for",
    where: "on the project's Ecosystem page",
    rest: [
      /\/channel\//,
      /\/contracts\b/,
      /\/contract-requests\b/,
      /\/contract-waits\b/,
      /^\S+ \/api\/projects\/:id\/(links|builder-runs|interface)\b/,
      /^\S+ \/api\/ecosystems\b/,
    ],
    tools: ['forge_channel', 'forge_ecosystem'],
  },
  {
    family: 'delivery act',
    why: 'it drives delivery (a pipeline, a job, a run, a deploy, a release, or the evidence a run records), which a run or a person on its page takes',
    where: 'on the issue or release page, or in a run',
    rest: [
      /^\S+ \/api\/(pipeline-runs|pipeline|jobs|issue-step-contexts|agent-sessions|runners|schedules)\b/,
      /\/(run-pipeline-step|merge|merge-pull-request|verdicts|events|criteria\/traces)$/,
      /\/(release-batches|release-records|integrations|runners|jobs)\b/,
    ],
    tools: ['forge_project_pipeline_runs', 'forge_coolify_deploy'],
  },
];

const DEFAULT_REFUSAL = {
  family: 'write no list names',
  why: 'no confirm card shows what this write would change',
  where: 'on the page the change belongs to',
} as const;

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ: ChatWriteVerdict = { verdict: 'read' };

const refusal = (f: Omit<RefusedFamily, 'rest' | 'tools'>): ChatWriteVerdict => ({
  verdict: 'refuse',
  family: f.family,
  why: f.why,
  where: f.where,
});

/** What a chat credential's REST request meets. */
export function decideRestWrite(write: ChatRestWrite): ChatWriteVerdict {
  const method = write.method.toUpperCase();
  if (READ_METHODS.has(method)) return READ;
  if (write.heldAs) return { verdict: 'hold', kind: write.heldAs };
  const call = `${method} ${write.route}`;
  const own = REFUSED_AT_THE_ROUTE[call];
  if (own) return { verdict: 'route-refuses', why: own };
  const listed = NOT_A_BUSINESS_WRITE.find((e) => e.rest.includes(call));
  if (listed) return { verdict: 'pass', why: listed.why };
  const family = REFUSED_FROM_CHAT.find((f) => f.rest.some((re) => re.test(call)));
  return refusal(family ?? DEFAULT_REFUSAL);
}

/**
 * What a chat's tool call meets. `grant` is the permission the call declares for the action it
 * names (`mcp-adapter.ts:ChatToolset.grantOf`); a tool that declares none is a write unless named.
 */
export function decideToolCall(
  name: string,
  argsJson: string,
  grant: ToolGrantEntry | null,
): ChatWriteVerdict {
  if (isWriteCall(name, argsJson)) return { verdict: 'hold', kind: kindOfToolCall(name, argsJson) };
  if (isRecordPreview(name, argsJson)) return READ;
  if (typeof grant === 'string' && grant.endsWith(':read')) return READ;
  const delegated = DELEGATES_TO_REST[name];
  if (delegated) return { verdict: 'pass', why: delegated };
  const listed = NOT_A_BUSINESS_WRITE.find((e) => e.tools.includes(name));
  if (listed) return { verdict: 'pass', why: listed.why };
  const family = REFUSED_FROM_CHAT.find((f) => f.tools.includes(name));
  return refusal(family ?? DEFAULT_REFUSAL);
}

/** The sentence a refused chat write is answered with, naming the family, why and where instead. */
export function refusedWriteText(
  verdict: Extract<ChatWriteVerdict, { verdict: 'refuse' }>,
  call: string,
): string {
  return `${call} is refused from chat as a ${verdict.family}: ${verdict.why}. A chat's write waits for the person's press on a confirm card (REQ-30 BC-4), and no card carries this one, so nothing was written. Tell the person they do it themselves ${verdict.where}; do not try it another way.`;
}
