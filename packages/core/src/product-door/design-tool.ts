// `forge_design`: what a project's product is designed as — its workflow designs, the suggestions
// made on its records, and the mockups attached to them — with the acts a person takes on each. Every
// action calls the service its REST route under `/api/projects/:id/{workflows,suggestions,mockups}`
// calls; a decision stays the act of whoever holds the permission the service checks.

import { DESIGN_TOOL_ACTIONS, DESIGN_TOOL_READS } from '@forge/contracts/mcp-product';
import {
  COMMENT_MOCKUP_SHAPE,
  commentMockupRequestSchema,
  PROPOSE_MOCKUP_SHAPE,
  proposeMockupRequestSchema,
} from '@forge/contracts/mockups';
import {
  CREATE_SUGGESTION_SHAPE,
  createSuggestionRequestSchema,
  SUGGESTION_STATUSES,
  suggestionSummaryOf,
} from '@forge/contracts/suggestions';
import { DESIGN_VIEWS } from '@forge/contracts/workflows';
import { z } from 'zod';
import { readProjectForecast } from '../forecast/index.js';
import { egressAs, MCP_DOOR } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { RefusalError } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { envelopeOf } from '../lib/write-envelope.js';
import {
  acceptMockup,
  commentOnMockup,
  getMockupAs,
  listMockupsAs,
  mockupCommentsAs,
  proposeMockup,
  returnMockup,
  withdrawMockup,
} from '../mockups/index.js';
import {
  acceptSuggestion,
  createSuggestion,
  listSuggestions,
  rejectSuggestion,
  reviseSuggestion,
  targetRefOf,
  withdrawSuggestion,
} from '../suggestions/index.js';
import {
  createWorkflow,
  DESIGN_DECISIONS,
  decideDesignAs,
  designStepsOf,
  designSummaryOf,
  listWorkflowsWithHealthAs,
  proposeDesign,
  readBackOf,
  readDesignAs,
  updateWorkflow,
  withdrawDesignAs,
  workflowSummaryOf,
  workflowView,
} from '../workflows/index.js';
import { need, parseArgs } from './args.js';
import { actorOf, forecastViewerOf, readAccess, readerOf } from './context.js';
import { issueProgress } from './progress.js';
import { agentStatesOf } from './work.js';

const input = z.strictObject({
  action: z.enum(DESIGN_TOOL_ACTIONS),
  projectId: z.uuid(),
  workflowId: z.uuid().optional().describe('design_*: the workflow whose design this is'),
  view: z
    .enum(DESIGN_VIEWS)
    .optional()
    .describe('design_list: summary | full; design_get: summary | steps | full'),
  revision: z.number().int().min(1).optional(),
  stepFrom: z.number().int().min(1).optional(),
  stepTo: z.number().int().min(1).optional(),
  issue: z.string().trim().min(1).max(200).optional(),
  decision: z.enum(DESIGN_DECISIONS).optional(),
  reason: z.string().optional(),
  body: z
    .unknown()
    .optional()
    .describe(
      'design_create/_revise, suggestion_create, mockup_propose, mockup_comment: the REST body',
    ),
  requirement: z.string().max(64).optional(),
  feedback: z.string().max(64).optional(),
  workflow: z.string().max(200).optional(),
  status: z.array(z.enum(SUGGESTION_STATUSES)).optional(),
  suggestionId: z.uuid().optional(),
  payload: z.unknown().optional(),
  mockup: z.string().trim().min(1).max(64).optional().describe('a mockup key (MK-n) or uuid'),
});
type Input = z.infer<typeof input>;

const SHAPE = '{ action, projectId, …the fields the action names in the description }';

const DESCRIPTION = `What the product is designed as, and the decisions on it: workflow designs, suggestions and mockups. Reading is open to anyone on the project; a decision (approve, return, accept, reject) is the act of whoever holds its permission — workflow-designs.approve, suggestions.approve, mockups — and the service refuses anyone else by name. Decide only what the person asked you to.
Workflow designs:
- design_list { projectId, view? }: every workflow with its design status, revision, approved revision and health.
- design_get { projectId, workflowId, view?: summary | steps | full, revision?, stepFrom?, stepTo? }: one design, whom it waits on, and \`progress\`: each issue building it, whether an agent works on it now, and when it is likely done.
- design_create { projectId, body: { baseRevision: null, document } } and design_revise { projectId, workflowId, body: { baseRevision, document, issue? } }: write a workflow document (the revision you read is the base).
- design_propose { projectId, workflowId, revision, issue? }: propose a revision for approval.
- design_decide { projectId, workflowId, revision, decision: ${DESIGN_DECISIONS.join(' | ')}, reason? }: a return says why.
- design_withdraw { projectId, workflowId, reason? }: take back a design no revision of which was approved; it leaves the list and Needs you. An approved design is refused DESIGN_WITHDRAW_APPROVED, one another live design names in basedOn DESIGN_WITHDRAW_PINNED.
Suggestions (on a requirement, issue, feedback item or workflow):
- suggestion_list { projectId, requirement? | issue? | feedback? | workflow?, status?: [${SUGGESTION_STATUSES.join(', ')}], view? }: summaries; view full reads each payload, a breakdown's slices among them.
- suggestion_create { projectId, body: ${CREATE_SUGGESTION_SHAPE} }.
- suggestion_accept { projectId, suggestionId, reason? }: accepting writes what it suggests. Accepting a breakdown files its issues at draft: that is how a requirement becomes delivery work, so read every slice before you accept.
- suggestion_reject { projectId, suggestionId, reason }, suggestion_revise { projectId, suggestionId, payload, reason } (rejects the original, proposes yours), suggestion_withdraw { projectId, suggestionId } (its producer only).
Mockups (MK-n): a screen or call proposed on the requirement, feedback item or issue it shapes, for a person to try, comment on and accept or return; never a local file. Method: GET /api/guides/mockups.md.
- mockup_list { projectId, requirement | feedback | issue }, mockup_get { projectId, mockup }, mockup_comments { projectId, mockup }: every comment on it and its earlier revisions, with where each points.
- mockup_propose { projectId, body: ${PROPOSE_MOCKUP_SHAPE} }. An HTML page is one self-contained file (inline CSS, scripts, data: images; only Google Fonts and cdnjs, jsdelivr or unpkg libraries load): it runs sandboxed and calls nothing. A returned one is answered by proposing it again with revises, settling each comment you addressed.
- mockup_comment { projectId, mockup, body: ${COMMENT_MOCKUP_SHAPE} }.
- mockup_accept { projectId, mockup, reason? } (an accepted requirement mockup is pinned by the next agree or re-pin), mockup_return { projectId, mockup, reason }, mockup_withdraw { projectId, mockup }.`;

/** A service's outcome as the tool answers it: the value, or its refusals thrown in the envelope. */
function settled<O extends { ok: true } | { ok: false; refusals: readonly Refusal[] }>(
  outcome: O,
  fallback: string,
): Extract<O, { ok: true }> {
  if (!outcome.ok) throw new RefusalError(outcome.refusals, fallback);
  return outcome as Extract<O, { ok: true }>;
}

/** A design read as the MCP door may see it: through the egress rule, as REST's routes read it. */
async function shownDesign<T>(ctx: McpContext, projectId: string, value: T, what: string) {
  const out = await egressAs(readerOf(ctx), projectId, 'design', value, what);
  if (!out.ok) throw new RefusalError([out.refusal], out.refusal.code);
  return out.value;
}

function bodyOf<S extends z.ZodTypeAny>(i: Input, schema: S, shape: string): z.infer<S> {
  const { body } = need(i, i.action, 'body');
  return parseArgs(schema, body, shape);
}

async function design_list(ctx: McpContext, i: Input) {
  const listed = await shownDesign(
    ctx,
    i.projectId,
    await listWorkflowsWithHealthAs(actorOf(ctx), i.projectId),
    'the workflows',
  );
  const workflows = i.view === 'full' ? listed : listed.map(workflowSummaryOf);
  return { workflows, returned: workflows.length };
}

/** Each issue building the design: whether an agent works on it now, and its forecast. */
async function buildsProgress(
  ctx: McpContext,
  projectId: string,
  builds: readonly { issueId: string; displayId: string; title: string; status: string }[],
) {
  if (builds.length === 0) return [];
  const access = await readAccess(ctx, projectId);
  const [forecast, agents] = await Promise.all([
    readProjectForecast(projectId, forecastViewerOf(ctx, access)),
    agentStatesOf(
      projectId,
      builds.map((b) => b.issueId),
    ),
  ]);
  const byId = new Map(forecast.issues.map((f) => [f.issueId, f.forecast]));
  return builds.map((b) => ({
    key: b.displayId,
    title: b.title,
    status: b.status,
    progress: issueProgress(byId.get(b.issueId) ?? null, agents.get(b.issueId) ?? null),
  }));
}

async function design_get(ctx: McpContext, i: Input) {
  const { workflowId } = need(i, 'design_get', 'workflowId');
  const design = await shownDesign(
    ctx,
    i.projectId,
    await readDesignAs(actorOf(ctx), i.projectId, workflowId),
    `workflow ${workflowId}`,
  );
  const view =
    i.view === 'full'
      ? design
      : i.view === 'steps'
        ? designStepsOf(design, { revision: i.revision, from: i.stepFrom, to: i.stepTo })
        : designSummaryOf(design);
  const wait = design.waitingOn;
  return {
    ...view,
    progress: {
      waitingOn:
        wait.kind === 'none'
          ? 'Nobody: nothing waits on a person.'
          : `${wait.who}${wait.act ? ` to ${wait.act}` : ''}`,
      eta: 'A design has no forecast of its own; the issues building it do.',
      builds: await buildsProgress(ctx, i.projectId, design.builds),
    },
  };
}

function writtenWorkflow(outcome: Awaited<ReturnType<typeof createWorkflow>>) {
  const done = settled(outcome, 'WORKFLOW_REFUSED');
  return { ...workflowView(done.row, done.document), created: done.created };
}

async function design_create(ctx: McpContext, i: Input) {
  const { body } = need(i, 'design_create', 'body');
  const { baseRevision, document } = envelopeOf(body);
  return writtenWorkflow(
    await createWorkflow({
      projectId: i.projectId,
      writer: actorOf(ctx),
      baseRevision,
      raw: document,
    }),
  );
}

async function design_revise(ctx: McpContext, i: Input) {
  const { workflowId, body } = need(i, 'design_revise', 'workflowId', 'body');
  const read = readBackOf(body, workflowId);
  if (!read.ok) throw new RefusalError(read.refusals, 'WORKFLOW_REFUSED');
  return {
    ...writtenWorkflow(
      await updateWorkflow({
        projectId: i.projectId,
        id: workflowId,
        writer: actorOf(ctx),
        baseRevision: read.baseRevision,
        raw: read.document,
        issue: read.issue,
      }),
    ),
    ignored: read.ignored,
  };
}

async function design_propose(ctx: McpContext, i: Input) {
  const { workflowId, revision } = need(i, 'design_propose', 'workflowId', 'revision');
  return settled(
    await proposeDesign({
      projectId: i.projectId,
      id: workflowId,
      writer: actorOf(ctx),
      revision,
      issue: i.issue,
    }),
    'WORKFLOW_REFUSED',
  ).design;
}

async function design_decide(ctx: McpContext, i: Input) {
  const { workflowId, revision, decision } = need(
    i,
    'design_decide',
    'workflowId',
    'revision',
    'decision',
  );
  return settled(
    await decideDesignAs({
      projectId: i.projectId,
      id: workflowId,
      decider: actorOf(ctx),
      revision,
      decision,
      reason: i.reason ?? null,
    }),
    'WORKFLOW_REFUSED',
  ).design;
}

async function design_withdraw(ctx: McpContext, i: Input) {
  const { workflowId } = need(i, 'design_withdraw', 'workflowId');
  return settled(
    await withdrawDesignAs({
      projectId: i.projectId,
      id: workflowId,
      writer: actorOf(ctx),
      reason: i.reason ?? null,
    }),
    'WORKFLOW_REFUSED',
  ).design;
}

const suggestionActorOf = (ctx: McpContext) => ({
  ...actorOf(ctx),
  deviceId: ctx.principal.deviceId ?? null,
});

async function suggestion_list(ctx: McpContext, i: Input) {
  const listed = await listSuggestions({
    projectId: i.projectId,
    userId: ctx.principal.userId,
    target: targetRefOf(i),
    statuses: i.status,
  });
  if (i.view === 'full') return listed;
  return { ...listed, suggestions: listed.suggestions.map(suggestionSummaryOf) };
}

type SuggestionAnswer = Exclude<Awaited<ReturnType<typeof acceptSuggestion>>, { ok: false }>;

function suggestionAnswer(outcome: Awaited<ReturnType<typeof acceptSuggestion>>) {
  const done: SuggestionAnswer = settled(outcome, 'SUGGESTION_REFUSED');
  return {
    suggestion: done.suggestion,
    ...(done.effect ? { effect: done.effect } : {}),
    ...(done.acceptRefused ? { acceptRefused: done.acceptRefused } : {}),
  };
}

async function suggestion_create(ctx: McpContext, i: Input) {
  const body = bodyOf(i, createSuggestionRequestSchema, CREATE_SUGGESTION_SHAPE);
  const target = targetRefOf(body);
  if (!target) {
    throw new RefusalError(
      [{ code: 'BAD_REQUEST', path: '/body', detail: `invalid body: ${CREATE_SUGGESTION_SHAPE}` }],
      'BAD_REQUEST',
    );
  }
  const actor = suggestionActorOf(ctx);
  return suggestionAnswer(
    await createSuggestion({
      projectId: i.projectId,
      actor,
      producerKind: actor.agency === 'agent' ? 'agent' : 'person',
      producerId: actor.userId,
      kind: body.kind,
      target,
      baseRevision: body.baseRevision,
      payload: body.payload,
      model: body.model ?? null,
    }),
  );
}

async function suggestion_accept(ctx: McpContext, i: Input) {
  const { suggestionId } = need(i, 'suggestion_accept', 'suggestionId');
  return suggestionAnswer(
    await acceptSuggestion({
      projectId: i.projectId,
      id: suggestionId,
      actor: suggestionActorOf(ctx),
      reason: i.reason,
    }),
  );
}

async function suggestion_reject(ctx: McpContext, i: Input) {
  const { suggestionId, reason } = need(i, 'suggestion_reject', 'suggestionId', 'reason');
  return suggestionAnswer(
    await rejectSuggestion({
      projectId: i.projectId,
      id: suggestionId,
      actor: suggestionActorOf(ctx),
      reason,
    }),
  );
}

async function suggestion_revise(ctx: McpContext, i: Input) {
  const { suggestionId, reason } = need(i, 'suggestion_revise', 'suggestionId', 'reason');
  return suggestionAnswer(
    await reviseSuggestion({
      projectId: i.projectId,
      id: suggestionId,
      actor: suggestionActorOf(ctx),
      payload: i.payload,
      reason,
    }),
  );
}

async function suggestion_withdraw(ctx: McpContext, i: Input) {
  const { suggestionId } = need(i, 'suggestion_withdraw', 'suggestionId');
  return suggestionAnswer(
    await withdrawSuggestion({
      projectId: i.projectId,
      id: suggestionId,
      actor: suggestionActorOf(ctx),
    }),
  );
}

const mockupAnswer = (outcome: Awaited<ReturnType<typeof acceptMockup>>) => ({
  mockup: settled(outcome, 'MOCKUP_REFUSED').mockup,
});

async function mockup_list(ctx: McpContext, i: Input) {
  return listMockupsAs(
    actorOf(ctx),
    i.projectId,
    { requirement: i.requirement, feedback: i.feedback, issue: i.issue },
    MCP_DOOR,
  );
}

async function mockup_get(ctx: McpContext, i: Input) {
  const { mockup } = need(i, 'mockup_get', 'mockup');
  return { mockup: await getMockupAs(actorOf(ctx), i.projectId, mockup, MCP_DOOR) };
}

async function mockup_comments(ctx: McpContext, i: Input) {
  const { mockup } = need(i, 'mockup_comments', 'mockup');
  return mockupCommentsAs(actorOf(ctx), i.projectId, mockup, MCP_DOOR);
}

async function mockup_comment(ctx: McpContext, i: Input) {
  const { mockup } = need(i, 'mockup_comment', 'mockup');
  const body = bodyOf(i, commentMockupRequestSchema, COMMENT_MOCKUP_SHAPE);
  const outcome = await commentOnMockup({
    projectId: i.projectId,
    ref: mockup,
    actor: actorOf(ctx),
    body,
  });
  return { comment: settled(outcome, 'MOCKUP_REFUSED').comment };
}

async function mockup_propose(ctx: McpContext, i: Input) {
  const body = bodyOf(i, proposeMockupRequestSchema, PROPOSE_MOCKUP_SHAPE);
  return mockupAnswer(await proposeMockup({ projectId: i.projectId, actor: actorOf(ctx), body }));
}

async function mockup_accept(ctx: McpContext, i: Input) {
  const { mockup } = need(i, 'mockup_accept', 'mockup');
  return mockupAnswer(
    await acceptMockup({
      projectId: i.projectId,
      ref: mockup,
      actor: actorOf(ctx),
      reason: i.reason,
    }),
  );
}

async function mockup_return(ctx: McpContext, i: Input) {
  const { mockup, reason } = need(i, 'mockup_return', 'mockup', 'reason');
  return mockupAnswer(
    await returnMockup({ projectId: i.projectId, ref: mockup, actor: actorOf(ctx), reason }),
  );
}

async function mockup_withdraw(ctx: McpContext, i: Input) {
  const { mockup } = need(i, 'mockup_withdraw', 'mockup');
  return mockupAnswer(
    await withdrawMockup({ projectId: i.projectId, ref: mockup, actor: actorOf(ctx) }),
  );
}

const ACTIONS = {
  design_list,
  design_get,
  design_create,
  design_revise,
  design_propose,
  design_decide,
  design_withdraw,
  suggestion_list,
  suggestion_create,
  suggestion_accept,
  suggestion_reject,
  suggestion_revise,
  suggestion_withdraw,
  mockup_list,
  mockup_get,
  mockup_comments,
  mockup_comment,
  mockup_propose,
  mockup_accept,
  mockup_return,
  mockup_withdraw,
} as const satisfies Record<(typeof DESIGN_TOOL_ACTIONS)[number], unknown>;

const READS: ReadonlySet<string> = new Set(DESIGN_TOOL_READS);

export const forgeDesignTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_design',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  reach: 'project',
  route: '/api/projects',
  grant: {
    byAction: Object.fromEntries(
      DESIGN_TOOL_ACTIONS.map((a) => [a, READS.has(a) ? 'projects:read' : 'projects:write']),
    ) as Record<(typeof DESIGN_TOOL_ACTIONS)[number], 'projects:read' | 'projects:write'>,
  },
  handler: async (args) => {
    const i = parseArgs(input, args, SHAPE);
    return ACTIONS[i.action](ctx, i);
  },
});
