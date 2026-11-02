// forge_support: a support group's or an operations room's session acts through this tool (REQ-75).
// Each action calls what its REST twin under /api/projects/:id/support/session calls (`acts.ts`), and
// only the room's own session, under the token its current turn was handed, is admitted.

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import {
  SUPPORT_ACTIONS,
  SUPPORT_RECORD_KINDS,
  supportAgreeRequestSchema,
  supportBuildRequestSchema,
  supportCommandRequestSchema,
  supportDeploymentRequestSchema,
  supportDeployRequestSchema,
  supportLinkRequestSchema,
  supportMoveIssueRequestSchema,
  supportProposeFixRequestSchema,
  supportReadRequestSchema,
  supportRecordRequestSchema,
  supportReplyRequestSchema,
  supportRunRequestSchema,
  supportSearchRequestSchema,
  supportThreadRequestSchema,
} from '@forge/contracts/support';
import {
  CHANNEL_ROLES,
  CHANNEL_ROUTES,
  supportAnnounceRequestSchema,
  supportAskOwnerRequestSchema,
  supportCheckResultRequestSchema,
  supportCommonIssueRequestSchema,
  supportMemberRequestSchema,
  supportRouteFieldsSchema,
  supportRouteRequestSchema,
  supportRuleRequestSchema,
} from '@forge/contracts/support-channel';
import {
  OPERATIONS_ACTIONS,
  operationsDraftFeedbackRequestSchema,
  operationsDraftRequirementRequestSchema,
  operationsIssuesRequestSchema,
  operationsMoveRequestSchema,
  operationsProjectsRequestSchema,
  operationsReleasesRequestSchema,
  operationsRequirementsRequestSchema,
  operationsResearchRequestSchema,
} from '@forge/contracts/support-operations';
import { z } from 'zod';

/** A Rocket.Chat group id, as a channel agent's brief and each message it is handed name it. */
const channelRidSchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'a channel agent only: the group (`channel` in what you were handed) an act naming no thread is for',
  );

import type { Refusal } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, refusedAnswer, zodToMcpSchema } from '../lib/tool.js';
import { type SupportActInput, supportAct } from './acts.js';
import { refusalOf } from './refusals.js';

/** The actions that write nothing: the rest post in a thread, file an item, or act or record for a member. */
export const SUPPORT_TOOL_READS: readonly string[] = [
  'search',
  'thread',
  'tools',
  'projects',
  'issues',
  'releases',
  'requirements',
  'channel',
  'deployment',
  'project',
];

const ACTIONS = [...SUPPORT_ACTIONS, ...OPERATIONS_ACTIONS] as const;

/** Each action's own request, judged whole once the action is known. */
const REQUESTS = {
  search: supportSearchRequestSchema,
  thread: supportThreadRequestSchema,
  tools: z.strictObject({}),
  reply: supportReplyRequestSchema,
  run: supportRunRequestSchema,
  propose_fix: supportProposeFixRequestSchema,
  record: supportRecordRequestSchema,
  move_issue: supportMoveIssueRequestSchema,
  build: supportBuildRequestSchema,
  deploy: supportDeployRequestSchema,
  deployment: supportDeploymentRequestSchema,
  project: z.strictObject({}),
  command: supportCommandRequestSchema,
  projects: operationsProjectsRequestSchema,
  issues: operationsIssuesRequestSchema,
  releases: operationsReleasesRequestSchema,
  requirements: operationsRequirementsRequestSchema,
  move: operationsMoveRequestSchema,
  draft_requirement: operationsDraftRequirementRequestSchema,
  draft_feedback: operationsDraftFeedbackRequestSchema,
  research: operationsResearchRequestSchema,
  channel: z.strictObject({}),
  member: supportMemberRequestSchema,
  rule: supportRuleRequestSchema,
  common_issue: supportCommonIssueRequestSchema,
  route: supportRouteRequestSchema,
  announce: supportAnnounceRequestSchema,
  ask_owner: supportAskOwnerRequestSchema,
  check_result: supportCheckResultRequestSchema,
  agree: supportAgreeRequestSchema,
  link: supportLinkRequestSchema,
  read: supportReadRequestSchema,
} as const satisfies Record<(typeof ACTIONS)[number], z.ZodType>;

// one flat strict input, every field but `action` optional, as the model is shown it: the action's
// own request then refuses a field it does not take, by name
const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  // an agreement's `message` comes first, so the channel acts' description of it is the one shown
  ...supportAgreeRequestSchema.partial().shape,
  ...supportLinkRequestSchema.partial().shape,
  // the channel acts' narrower `text` comes first, so the reply's wider one is the one shown
  ...supportMemberRequestSchema.partial().shape,
  ...supportRuleRequestSchema.partial().shape,
  ...supportCommonIssueRequestSchema.partial().shape,
  ...supportRouteFieldsSchema.partial().shape,
  ...supportAskOwnerRequestSchema.partial().shape,
  // a read's `check` and `args` come first, so the check result's and a fix's are the ones shown
  ...supportReadRequestSchema.partial().shape,
  ...supportCheckResultRequestSchema.partial().shape,
  // the build's narrower title comes first, so the wider one a record takes is the one shown
  ...supportBuildRequestSchema.partial().shape,
  ...supportSearchRequestSchema.partial().shape,
  ...supportReplyRequestSchema.partial().shape,
  ...supportProposeFixRequestSchema.partial().shape,
  ...supportRecordRequestSchema.partial().shape,
  ...operationsIssuesRequestSchema.partial().shape,
  ...operationsMoveRequestSchema.partial().shape,
  ...operationsDraftFeedbackRequestSchema.partial().shape,
  ...operationsResearchRequestSchema.partial().shape,
  ...supportDeployRequestSchema.partial().shape,
  ...supportCommandRequestSchema.partial().shape,
  // an issue move's status, or a route's destination: each action's own request judges which
  // one enum, so the published tool gains values rather than changing shape
  to: z.enum([...ISSUE_STATUSES, ...CHANNEL_ROUTES]).optional(),
  // a channel agent answers several groups: an act naming no thread or message of one names it here
  rid: channelRidSchema.optional(),
});

const SHAPE = [
  'search { query }',
  'thread { thread }',
  'tools {}',
  'reply { thread, text }',
  'run { thread, tool, args? }',
  'propose_fix { thread, tool, args?, asker }',
  `record { thread, kind: ${SUPPORT_RECORD_KINDS.join(' | ')}, title, summary, whereSeen?, asker? }`,
  'move_issue { thread, issue, to, reason? }',
  'build { thread, branch, title, summary }',
  'deploy { thread, target }',
  'deployment { target }',
  'project {}',
  'command { thread, host, command }',
  'projects {}',
  'issues { project, status?, key? }',
  'releases { project }',
  'requirements { project }',
  'move { thread, issue, to, reason?, project? }',
  'draft_requirement { thread, project, title, summary }',
  `draft_feedback { thread, project, kind: ${SUPPORT_RECORD_KINDS.join(' | ')}, title, summary, one of requirement | issue | screen }`,
  'research { thread, url }',
  'channel {}',
  `member { member, roles: (${CHANNEL_ROLES.join(' | ')})[], askFor?, message }`,
  'rule { thread, message, text }',
  'common_issue { threads, question, answer, feedback? }',
  `route { thread, to: ${CHANNEL_ROUTES.join(' | ')}, member? (technical, product), title? (forge), text }`,
  'announce { text }',
  'ask_owner { thread, question, record?, forgeQuestion? }',
  'check_result { check, finding: string | null }',
  'agree { thread, proposal, message, decision?: agree | decline }',
  'link { thread, member }',
  'read { name, args?, thread?, check? }',
  'any action may add rid: the group, where you answer several and the act names no thread',
].join('; ');

const DESCRIPTION = [
  'Answer a Rocket.Chat support group, or an operations room, as its assistant. Every answer people see goes through this tool; nothing you write outside it reaches the room.',
  'search {query}: the project knowledge and its published OpenAPI contracts; each hit carries `cite`, which you put in brackets after what it supports.',
  'thread {thread}: the thread so far, oldest first. tools {}: the checks (diagnose) and changes (fix) this group grants you.',
  "reply {thread, text}: post your answer in that thread. It is screened before it is posted; a refusal names what to rewrite. In a group the product's users read, any post holding an issue key, an MR or PR number, an environment variable name, a commit sha or a credential word is refused SUPPORT_INTERNAL_CODE.",
  'run {thread, tool, args}: run a granted diagnose check; you get what came back, and the thread is shown nothing.',
  'propose_fix {thread, tool, args, asker}: propose a granted fix for the person who asked (`from.id`). Nothing is posted: you are handed `proposal`, whom it waits on and when it expires. Ask that person in your own words; nothing runs until you cite their answer with agree.',
  `record {thread, kind, title, summary, asker?}: propose recording what needs code or a decision as Feedback for the team (kind ${SUPPORT_RECORD_KINDS.join(' | ')}). Nothing is posted and nothing is filed yet: you are handed \`proposal\`. Ask the asker (the thread's first writer unless named) in your own words whether to record it; when they agree in plain words, call agree. You are handed the key then, and told again once it is live, shipped or declined: then post its result in its thread. Never post progress, and never promise a date.`,
  'agree {thread, proposal, message, decision?}: the person answered your proposal. Cite the id of their message (`message` in what you were handed); decision "decline" when they said no. Forge checks the message is theirs (the asker, or for a build, a deploy, a host change or a channel fix a confirmer the room allows), in the proposal\'s thread, and written after the proposal, then runs or files it and hands you what came of it: tell the person in your own words. A refusal names why; nothing is posted either way.',
  'link {thread, member}: whether a member (`from.id`) is linked to a Forge account, so what they ask you to do as them can run; where not, you are handed the page to give them, which they open signed in to Forge. You are told when they have linked. Nothing is posted.',
  "The channel record (every bot of this group reads it): channel {} reads it. member {member, roles, askFor?, message} records the roles you inferred for a member from a message, and what to ask them for; a member a person confirmed is refused and stays as it is. rule {thread, message, text} keeps an instruction a confirmed team member gave as a channel rule linked to that message. common_issue {threads, question, answer, feedback?} keeps a question asked in two or more threads with its one answer, a defect's naming its Feedback key. route {thread, to, ...} sends a need where it belongs, never mixed: to forge {title, text} files a problem with Forge itself as Forge feedback and posts nothing; to technical or product {member, text} asks that one member, who holds the role, in the thread. announce {text} is the one top-level post, for news affecting everyone, at most one an hour. ask_owner {thread, question, record?} asks the owner this binding names, only in a thread of the owner's room (the binding's agent.ownerRoom), in plain words; anywhere else, or at top level, it is refused SUPPORT_NOT_THE_OWNER_ROOM: the owner's next message there is the answer, which you read as your next message and which is also written on the issue `record` names (ISS-n); asking for a master, name its open Forge question as `forgeQuestion` (its id) and the owner's answer is recorded on it as theirs, waking that master. Ask only what no record, log or code can answer, once per question. check_result {check, finding} answers a scheduled check you were handed (its thread is the check): your one finding, in your words, screened and posted at the channel's top level, or null and nothing is posted; one result per check. A reply mentions at most one person: the asker or a member listed with what to ask them for; never @all or @here. Nothing secret or personal (an email, a phone number) is kept in the record.",
  "read {name, args?, thread? | check?} runs a production read your room's grant declares (ops_reads), by the name and parameters your brief lists: at once, read-only, through the box, which keeps the read's own credential; you get what it printed, scrubbed, and nothing is posted. Name the thread it answers, or the check it serves. An undeclared read is refused SUPPORT_READ_UNDECLARED, and an argument outside its parameter's pattern, values or length, or one it does not take, SUPPORT_READ_ARGS; nothing runs. What your room's grant opens (your brief lists what it holds): move_issue moves an issue of this project as the member who wrote last in the thread (deliver); build proposes committing your working copy of the development branch on a feat/ or fix/ branch, pushing it and opening a change request into it (build); deploy proposes deploying a bound target the grant names (deploy); deployment {target} reads that target's latest deployment record (its status, when, and the revision it runs), to watch a deploy after a merge, and posts nothing; project {} (a channel agent's) reads the project document, its source, environments and their deploy bindings; command runs a command on a host the grant names (run_commands) — one that only reads runs at once and you get its output, posted nowhere; anything else is proposed. A build, a deploy and a command that changes a host are proposals: ask a confirmer the room names, in your own words, and cite their plain yes with agree; you are handed the result. An ability the room was not granted is refused SUPPORT_ABILITY_NOT_GRANTED, naming who can grant it; nothing is posted, so say it in your own words if the person should know.",
  "In an operations room (your brief says which room you answer) the acts are your role's: projects, issues and releases read the projects of the room's scope; move changes an issue's status, and draft_requirement and draft_feedback draft product direction for a person to decide, each as the member who wrote last in the thread and under their own Forge permissions; research reads one public https page. An act your role is not granted, a project outside the scope, or a member Forge cannot name is refused by name: tell the thread what the refusal says. The support group acts (search, tools, run, propose_fix, record) are refused there, as these are in a support group.",
  `A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and posts nothing. Actions: ${SHAPE}.`,
].join(' ');

/** The one project a support session's token is fenced to. */
function projectOf(principal: {
  projectIds: readonly string[] | null;
  boundProjectId: string | null;
}): string | null {
  if (principal.projectIds?.length === 1) return principal.projectIds[0] ?? null;
  return principal.boundProjectId;
}

export const forgeSupportTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_support',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const parsed = inputSchema.safeParse(args);
    const action = parsed.success ? parsed.data.action : null;
    const rid = parsed.success ? parsed.data.rid : undefined;
    const judged =
      parsed.success && action ? REQUESTS[action].safeParse(withoutAction(parsed.data)) : parsed;
    if (!judged.success || !action) {
      const refusals: Refusal[] = (judged.success ? [] : judged.error.issues).map((i) => ({
        code: 'BAD_REQUEST',
        path: `/${i.path.join('/')}`,
        detail: `${i.message}; forge_support takes { action: ${ACTIONS.join(' | ')} } with ${SHAPE}`,
      }));
      return refusedAnswer(refusals, 'SUPPORT_REFUSED');
    }
    const projectId = projectOf(ctx.principal);
    if (!projectId) {
      return refusedAnswer(
        [
          refusalOf(
            'SUPPORT_NOT_THE_ROOM_SESSION',
            '',
            "only a support group's own session acts here, and this credential is fenced to no single project",
          ),
        ],
        'SUPPORT_REFUSED',
      );
    }
    const out = await supportAct(
      { userId: ctx.principal.userId, tokenId: ctx.principal.tokenId, projectId },
      { action, ...(judged.data as object) } as SupportActInput,
      { rid },
    );
    return out.ok ? out.value : refusedAnswer(out.refusals, 'SUPPORT_REFUSED');
  },
});

function withoutAction(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, rid: _rid, ...rest } = input;
  return rest;
}
