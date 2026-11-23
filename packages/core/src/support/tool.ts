// forge_support: a support group's or an operations room's session acts through this tool (REQ-75).
// Each action calls what its REST twin under /api/projects/:id/support/session calls (`acts.ts`), and
// only the room's own session, under the token its current turn was handed, is admitted.

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { REFERENCE_KINDS } from '@forge/contracts/references';
import {
  SECRET_SLOT_KINDS,
  SUPPORT_ACTIONS,
  SUPPORT_RECORD_KINDS,
  SUPPORT_ROUTING_CONFIDENCES,
  SUPPORT_ROUTING_DECISIONS,
  SUPPORT_ROUTING_SIGNALS,
  supportAgreeRequestSchema,
  supportApproveRequestSchema,
  supportBuildRequestSchema,
  supportCommandRequestSchema,
  supportDecideRequestSchema,
  supportDeploymentRequestSchema,
  supportDeployRequestSchema,
  supportImageRequestSchema,
  supportLinkRequestSchema,
  supportMoveIssueRequestSchema,
  supportOwnerActRequestSchema,
  supportOwnerConsentRequestSchema,
  supportOwnerSignInRequestSchema,
  supportProjectRequestSchema,
  supportPromiseRequestSchema,
  supportProposeFixRequestSchema,
  supportReadRequestSchema,
  supportRecordRequestSchema,
  supportReplyRequestSchema,
  supportRunRequestSchema,
  supportSearchRequestSchema,
  supportSecretLinkRequestSchema,
  supportSilentRequestSchema,
  supportThreadRequestSchema,
} from '@forge/contracts/support';
import {
  CHANNEL_ROLES,
  CHANNEL_ROUTES,
  SUPPORT_FORGE_ACTS,
  supportAnnounceRequestSchema,
  supportAnswerQuestionRequestSchema,
  supportAskerRequestSchema,
  supportAskOwnerRequestSchema,
  supportCheckResultRequestSchema,
  supportCommonIssueRequestSchema,
  supportForgeActRequestSchema,
  supportGuideRequestSchema,
  supportMemberRequestSchema,
  supportReleaseDecisionRequestSchema,
  supportRouteFieldsSchema,
  supportRouteRequestSchema,
  supportRuleRequestSchema,
} from '@forge/contracts/support-channel';
import { supportLookRequestSchema } from '@forge/contracts/support-look';
import {
  supportAskMasterRequestSchema,
  supportInFlightRequestSchema,
  supportRaiseOwedRequestSchema,
} from '@forge/contracts/support-master-ask';
import {
  OPERATIONS_ACTIONS,
  operationsDraftFeedbackRequestSchema,
  operationsDraftRequirementRequestSchema,
  operationsFeedbackRequestSchema,
  operationsIssuesRequestSchema,
  operationsMoveRequestSchema,
  operationsProjectsRequestSchema,
  operationsReleasesRequestSchema,
  operationsRequirementsRequestSchema,
  operationsResearchRequestSchema,
} from '@forge/contracts/support-operations';
import {
  supportReferenceAddRequestSchema,
  supportReferenceCiteRequestSchema,
  supportReferenceProposeRequestSchema,
  supportReferencesRequestSchema,
} from '@forge/contracts/support-references';
import { supportAuditRequestSchema } from '@forge/contracts/support-reply-audit';
import { supportTechnicalRequestSchema } from '@forge/contracts/support-technical';
import { supportTermRequestSchema } from '@forge/contracts/support-terms';
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
import {
  type ContextScopedMcpToolFactory,
  refusedAnswer,
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { permissionless } from '../permissions/index.js';
import { SUPPORT_ACT_CARDS } from './act-cards.js';
import { type SupportActInput, supportAct } from './acts.js';
import type { ImageRead } from './images.js';
import { refusalOf } from './refusals.js';
import { SECRET_LINK_TOOL_FIELDS } from './secret-tool-fields.js';
import { supportActEntries, supportToolDescription } from './tool-description.js';

/** The actions that write nothing: the rest post in a thread, file an item, or act or record for a member. */
export const SUPPORT_TOOL_READS: readonly string[] = [
  'search',
  'thread',
  'tools',
  'projects',
  'issues',
  'releases',
  'requirements',
  'feedback',
  'channel',
  'deployment',
  'project',
  'image',
  'in_flight',
  'asker',
  'guide',
  'references',
  'secret_link',
];

const ACTIONS = [...SUPPORT_ACTIONS, ...OPERATIONS_ACTIONS] as const;

/** Each action's own request, judged whole once the action is known. */
export const SUPPORT_ACT_REQUESTS = {
  search: supportSearchRequestSchema,
  thread: supportThreadRequestSchema,
  tools: z.strictObject({}),
  reply: supportReplyRequestSchema,
  silent: supportSilentRequestSchema,
  decide: supportDecideRequestSchema,
  approve: supportApproveRequestSchema,
  run: supportRunRequestSchema,
  propose_fix: supportProposeFixRequestSchema,
  record: supportRecordRequestSchema,
  move_issue: supportMoveIssueRequestSchema,
  build: supportBuildRequestSchema,
  deploy: supportDeployRequestSchema,
  deployment: supportDeploymentRequestSchema,
  project: supportProjectRequestSchema,
  command: supportCommandRequestSchema,
  projects: operationsProjectsRequestSchema,
  issues: operationsIssuesRequestSchema,
  releases: operationsReleasesRequestSchema,
  requirements: operationsRequirementsRequestSchema,
  feedback: operationsFeedbackRequestSchema,
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
  answer_question: supportAnswerQuestionRequestSchema,
  check_result: supportCheckResultRequestSchema,
  agree: supportAgreeRequestSchema,
  link: supportLinkRequestSchema,
  read: supportReadRequestSchema,
  image: supportImageRequestSchema,
  promise: supportPromiseRequestSchema,
  owner_consent: supportOwnerConsentRequestSchema,
  owner_act: supportOwnerActRequestSchema,
  owner_sign_in: supportOwnerSignInRequestSchema,
  release_decision: supportReleaseDecisionRequestSchema,
  ask_master: supportAskMasterRequestSchema,
  in_flight: supportInFlightRequestSchema,
  raise_owed: supportRaiseOwedRequestSchema,
  technical: supportTechnicalRequestSchema,
  owner_forge_act: supportForgeActRequestSchema,
  asker: supportAskerRequestSchema,
  guide: supportGuideRequestSchema,
  audit: supportAuditRequestSchema,
  references: supportReferencesRequestSchema,
  reference_add: supportReferenceAddRequestSchema,
  reference_cite: supportReferenceCiteRequestSchema,
  reference_propose: supportReferenceProposeRequestSchema,
  term: supportTermRequestSchema,
  secret_link: supportSecretLinkRequestSchema,
  look: supportLookRequestSchema,
} as const satisfies Record<(typeof ACTIONS)[number], z.ZodType>;

/** Each action's request as `forge_describe` answers it, its entry below naming exactly these (ISS-1033). */
const ACTION_REQUESTS: Readonly<Record<string, Record<string, unknown>>> = Object.fromEntries(
  Object.entries(SUPPORT_ACT_REQUESTS).map(([action, request]) => [
    action,
    z.toJSONSchema(request, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
  ]),
);

// one flat strict input, every field but `action` optional, as the model is shown it: the action's
// own request then refuses a field it does not take, by name
const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  // an ask of a master: its question and project are the ones every later request's shape overrides
  ...supportAskMasterRequestSchema.partial().shape,
  ...supportRaiseOwedRequestSchema.partial().shape,
  // an agreement's `message` comes first, so the channel acts' description of it is the one shown
  ...supportAgreeRequestSchema.partial().shape,
  ...supportLinkRequestSchema.partial().shape,
  // the channel acts' narrower `text` comes first, so the reply's wider one is the one shown
  ...supportMemberRequestSchema.partial().shape,
  ...supportRuleRequestSchema.partial().shape,
  ...supportCommonIssueRequestSchema.partial().shape,
  ...supportRouteFieldsSchema.partial().shape,
  ...supportAskOwnerRequestSchema.partial().shape,
  ...supportAnswerQuestionRequestSchema.partial().shape,
  // a read's `check` and `args` come first, so the check result's and a fix's are the ones shown
  ...supportReadRequestSchema.partial().shape,
  ...supportCheckResultRequestSchema.partial().shape,
  // the build's narrower title comes first, so the wider one a record takes is the one shown
  ...supportBuildRequestSchema.partial().shape,
  ...supportSearchRequestSchema.partial().shape,
  ...supportReplyRequestSchema.partial().shape,
  ...supportSilentRequestSchema.partial().shape,
  failed: supportAuditRequestSchema.shape.failed.optional(),
  missed: supportAuditRequestSchema.shape.missed,
  signals: supportDecideRequestSchema.shape.signals.optional(),
  confidence: supportDecideRequestSchema.shape.confidence.optional(),
  ...supportProposeFixRequestSchema.partial().shape,
  ...supportRecordRequestSchema.partial().shape,
  ...operationsIssuesRequestSchema.partial().shape,
  ...operationsMoveRequestSchema.partial().shape,
  ...operationsDraftFeedbackRequestSchema.partial().shape,
  ...operationsResearchRequestSchema.partial().shape,
  ...supportDeployRequestSchema.partial().shape,
  ...supportCommandRequestSchema.partial().shape,
  // the owner's consent or its withdrawal, for a product by its binding name (ISS-1013)
  // and a person's release decision, read from his own message (ISS-1206)
  // and a routing decision for a message (ISS-1243)
  decision: z
    .enum([
      'agree',
      'decline',
      'give',
      'withdraw',
      'approve',
      'return',
      ...SUPPORT_ROUTING_DECISIONS,
    ])
    .optional(),
  version: supportReleaseDecisionRequestSchema.shape.version.optional(),
  product: supportOwnerConsentRequestSchema.shape.product,
  // the owner's cited agreement to an act its product gates on approval (ISS-1014)
  agreement: supportOwnerActRequestSchema.shape.agreement,
  // the owner's Forge act and the item it is made on (ISS-1243)
  act: supportForgeActRequestSchema.shape.act.optional(),
  item: supportForgeActRequestSchema.shape.item.optional(),
  carry: supportForgeActRequestSchema.shape.carry,
  commit: supportForgeActRequestSchema.shape.commit,
  baseRevision: supportForgeActRequestSchema.shape.baseRevision,
  document: supportForgeActRequestSchema.shape.document,
  rule: supportForgeActRequestSchema.shape.rule,
  ruling: supportForgeActRequestSchema.shape.ruling,
  // a picture's place in its message; the message is the agreement's own field (ISS-1010)
  n: supportImageRequestSchema.shape.n,
  // an issue move's status, or a route's destination: each action's own request judges which
  // one enum, so the published tool gains values rather than changing shape
  to: z.enum([...ISSUE_STATUSES, ...CHANNEL_ROUTES]).optional(),
  // what a need raised in the technical channel is (ISS-1243)
  need: supportTechnicalRequestSchema.shape.need.optional(),
  // a project's reference sources (ISS-1252): the fields their acts take beside the ones above
  ...supportReferencesRequestSchema.partial().shape,
  ...supportReferenceCiteRequestSchema.omit({ why: true, project: true }).partial().shape,
  areas: supportReferenceAddRequestSchema.shape.areas.optional(),
  priority: supportReferenceAddRequestSchema.shape.priority,
  followReleases: supportReferenceAddRequestSchema.shape.followReleases,
  shared: supportReferenceAddRequestSchema.shape.shared,
  evidence: supportReferenceProposeRequestSchema.shape.evidence.optional(),
  // a term a person names (ISS-1256): the fields its act takes beside the ones above
  ...supportTermRequestSchema.pick({ slug: true, means: true, module: true, quote: true }).partial()
    .shape,
  aliases: supportTermRequestSchema.shape.aliases,
  anchor: supportTermRequestSchema.shape.anchor,
  // the one secret door's slot, its environment and key widened to what other acts take too
  ...SECRET_LINK_TOOL_FIELDS,
  // a look at a screen (ISS-1356): the fields its act takes beside the ones above
  ...supportLookRequestSchema
    .pick({ path: true, viewport: true, as: true, box: true, step: true, close: true })
    .partial().shape,
  // a look's pictures a reply posts after its text (ISS-1386)
  shots: supportReplyRequestSchema.shape.shots,
  // a field two acts' requests both take, each judged by its own act's request: a record's or a
  // draft's kind, or a reference source's; a page's or a source's address; a one-line why, or what a
  // source teaches
  kind: z
    .enum([...SUPPORT_RECORD_KINDS, ...REFERENCE_KINDS, ...SECRET_SLOT_KINDS])
    .optional()
    .describe(
      `record, draft_feedback: ${SUPPORT_RECORD_KINDS.join(' | ')}; reference_add, reference_propose: ${REFERENCE_KINDS.join(' | ')}; secret_link: ${SECRET_SLOT_KINDS.join(' | ')}`,
    ),
  url: z
    .string()
    .max(2000)
    .optional()
    .describe("research: an https page; reference_add, reference_propose: the source's address"),
  why: z
    .string()
    .max(600)
    .optional()
    .describe(
      'reply, decide: one line, why; reference_add, reference_propose: what the project learns from the source; reference_cite: why you took or rejected it; secret_link: what the value is for, in plain words a person reads above the field',
    ),
  // a channel agent answers several groups: an act naming no thread or message of one names it here
  rid: channelRidSchema.optional(),
});

const SIGNATURES = [
  'search { query, project? }',
  'thread { thread }',
  'tools {}',
  'reply { thread, text, why?, request?: { thread, message }, shots?: [<a look picture>] }',
  'silent { thread, message?, reason }',
  `decide { thread, message?, decision: ${SUPPORT_ROUTING_DECISIONS.join(' | ')}, project?, signals: (${SUPPORT_ROUTING_SIGNALS.join(' | ')})[], confidence: ${SUPPORT_ROUTING_CONFIDENCES.join(' | ')}, why }`,
  'run { thread, tool, args? }',
  'propose_fix { thread, tool, args?, asker }',
  `record { thread, kind: ${SUPPORT_RECORD_KINDS.join(' | ')}, title, summary, whereSeen?, asker?, project?, separate?, pictures?: [{ message, n? }] }`,
  'approve { thread, message, feedback, project? }',
  'move_issue { thread, message, issue, to, reason? }',
  'build { thread, branch, title, summary }',
  'deploy { thread, target }',
  'deployment { target }',
  'project { project? }',
  'command { thread, host, command }',
  'projects {}',
  'issues { project, status?, key? } (a row waiting on a person carries waiting: who, owes, questions with options, reason; one issue named by key carries its latest notes and step handoffs)',
  'releases { project }',
  'requirements { project }',
  "feedback { project, key? } (a reached project's feedback, newest first, each with where it stands; one by key)",
  'move { thread, message, issue, to, reason?, project? }',
  'draft_requirement { thread, message, project, title, summary }',
  `draft_feedback { thread, message, project, kind: ${SUPPORT_RECORD_KINDS.join(' | ')}, title, summary, one of requirement | issue | screen }`,
  'research { thread, url }',
  'channel {}',
  `member { member, roles: (${CHANNEL_ROLES.join(' | ')})[], askFor?, message, thread? }`,
  'rule { thread, message, text }',
  'common_issue { threads, question, answer, feedback? }',
  `route { thread, to: ${CHANNEL_ROUTES.join(' | ')}, member? (technical, product), title? (forge), text }`,
  'announce { text }',
  'ask_owner { thread, question, record?, forgeQuestion? }',
  'answer_question { thread, forgeQuestion?, source | message, option? | answer? }',
  'check_result { check, finding: string | null }',
  'agree { thread, proposal, message, decision?: agree | decline }',
  'link { thread, member }',
  'read { name, args?, thread?, check? }',
  'image { message, n?, thread? }',
  'promise { thread, issue, environment, asker?, project? }',
  'owner_consent { thread, message, decision: give | withdraw, product? }',
  'owner_act { thread, message, tool, args?, agreement? }',
  'owner_sign_in { thread, product? }',
  'release_decision { thread, message, project, version, decision: approve | return, reason? }',
  'ask_master { thread, question, project? }',
  'in_flight { thread }',
  'raise_owed { thread, text, answers? }',
  'technical { thread, need: permission | approval | finding | ask, text, answers? }',
  'asker { thread, message }',
  'guide {}',
  'audit { thread, message, failed: [{ line, why }], missed?: [{ door, why }] }',
  `owner_forge_act { thread, message, project, act: ${SUPPORT_FORGE_ACTS.join(' | ')}, item, reason?, carry?, commit?, baseRevision?, document?, rule?, ruling? }`,
  'references { project?, area?, q? }',
  `reference_add { thread, message, project?, kind: ${REFERENCE_KINDS.join(' | ')}, url, why, areas, title?, priority?, followReleases?, shared? }`,
  'reference_cite { source, ref, verdict: take | reject, why, about?, project? }',
  'reference_propose { kind, url, why, areas, evidence, title?, priority?, followReleases?, project? }',
  'term { thread, message, slug, title, means, module, quote, aliases?, anchor?, project? }',
  'look { thread, environment?, path?, viewport?: desktop | phone, as?, box?, step?, close? } (a first look names environment; a look again names box)',
  'secret_link { thread, why, project?, kind: variable, environment (null: every environment), key | kind: testing, profile, actor | service | kind: integration, provider; shape?: value | file | mailbox | signin | { fields }, example?, presign? }',
];

/** What every act shares, said once in the description and in a refusal. */
const NOTES = [
  'any action may add rid: the group, where you answer several and the act names no thread',
  'a channel agent following several projects names one as project on search, project, record, issues, releases and requirements, and on promise where the key alone does not say; its home when omitted',
];

const SHAPE = [...SIGNATURES, ...NOTES].join('; ');

// each act's entry is its card's (ISS-1251): forge_describe answers the card beside it
const ENTRIES = supportActEntries(ACTIONS, SIGNATURES);
const DESCRIPTION = supportToolDescription(ENTRIES, NOTES);

// what each action's REST twin under /api/projects/:id/support/session declares: no permission, its
// door admitting only the room's own session under its current turn's token (support/access.ts
// sessionCaller), which every act runs before it reads or writes anything
const SESSION_ONLY = permissionless(
  'credential',
  "only the room's own session, under its current turn's token, is admitted (support/access.ts)",
);
const PERMISSION = {
  byAction: {
    ...Object.fromEntries(ACTIONS.map((a) => [a, SESSION_ONLY])),
    read: permissionless(
      'credential',
      "only the room's own session, under its current turn's token, is admitted (support/access.ts), and the room's grant gates the read",
    ),
    answer_question: permissionless(
      'credential',
      "only the room's own session, under its current turn's token, is admitted (support/access.ts), and only a question handed to that room is answered",
    ),
  },
} as const;

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
  actionEntries: ENTRIES,
  inputSchema: zodToMcpSchema(inputSchema),
  actionRequests: ACTION_REQUESTS,
  // when a room agent reaches for each act (ISS-1251): the room brief's map renders from the same cards
  cards: SUPPORT_ACT_CARDS,
  source: sourceOf(import.meta.url),
  permission: PERMISSION,
  handler: async (args) => {
    const parsed = inputSchema.safeParse(args);
    const action = parsed.success ? parsed.data.action : null;
    const rid = parsed.success ? parsed.data.rid : undefined;
    const judged =
      parsed.success && action
        ? SUPPORT_ACT_REQUESTS[action].safeParse(withoutAction(parsed.data))
        : parsed;
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
    if (!out.ok) return refusedAnswer(out.refusals, 'SUPPORT_REFUSED');
    return action === 'image' ? imageAnswer(out.value as ImageRead) : out.value;
  },
});

/**
 * A picture as `uploads.read` hands one (ISS-532): its name and type framed as data, then the image
 * block the model views; the structured answer names the block and repeats no bytes.
 */
function imageAnswer(read: ImageRead): Record<string, unknown> {
  // the name is the writer's: it rides only inside the data frame
  const { dataBase64, name: _name, ...meta } = read;
  return {
    _mcpContent: [
      {
        type: 'text',
        text: markUntrusted(`Image name="${read.name}" mime="${read.mime}".`, {
          source: 'support group member picture',
        }),
      },
      { type: 'image', data: dataBase64, mimeType: read.mime },
    ],
    ...meta,
    image: { contentIndex: 1, mimeType: read.mime },
    note: 'The picture is content block 1, which this structured answer does not repeat.',
  };
}

function withoutAction(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, rid: _rid, ...rest } = input;
  return rest;
}
