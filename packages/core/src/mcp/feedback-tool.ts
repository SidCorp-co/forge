// project_feedback: a BA's door onto a project's own feedback (FB-n) over /mcp (owner direction
// 2026-10-16: /mcp serves the product layer). Every action is a REST route's own service call —
// GET/POST /api/projects/:id/feedback, …/:fb, …/:fb/similar, …/:fb/clarification — and every read
// carries the progress block of the work the item was routed to (`product-progress.ts`).

import {
  CREATE_FEEDBACK_SHAPE,
  createFeedbackRequestSchema,
  FEEDBACK_PHASES,
  type FeedbackSummary,
  feedbackClarificationRequestSchema,
} from '@forge/contracts/feedback';
import { z } from 'zod';
import {
  askClarification,
  createFeedback,
  detailAs,
  listFeedbackAs,
  similarFeedbackAs,
} from '../feedback/index.js';
import { forecastViewerOf, readFeedbackForecasts } from '../forecast/index.js';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
  zodToMcpSchema,
} from '../lib/tool.js';
import {
  type FeedbackReads,
  feedbackDetail,
  feedbackProgress,
  feedbackRow,
  issuesOfRequirements,
  liveRunsByIssue,
  requirementIdsOf,
  routedRequirements,
} from '../product-progress/index.js';
import { resolveEffectiveProjectId } from '../projects/index.js';

const ACTIONS = ['list', 'get', 'progress', 'similar', 'submit', 'clarify'] as const;
const READS = ['list', 'get', 'progress', 'similar'] as const;
export const PROJECT_FEEDBACK_READ_ACTIONS: readonly string[] = READS;

const feedbackKey = z
  .string()
  .regex(/^FB-\d+$/, 'a feedback item is named by its key, FB-n')
  .describe('the feedback key, e.g. FB-12');

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z
    .uuid()
    .optional()
    .describe('the project; left out, the X-Forge-Project-Slug header or the token’s one project'),
  feedback: feedbackKey.optional(),
  phase: z.array(z.enum(FEEDBACK_PHASES)).min(1).optional().describe('list: keep these phases'),
  q: z.string().max(200).optional().describe('list: words the title holds'),
  ...createFeedbackRequestSchema.shape,
  kind: createFeedbackRequestSchema.shape.kind.optional(),
  title: createFeedbackRequestSchema.shape.title.optional(),
  ...feedbackClarificationRequestSchema.partial().shape,
});

type Input = z.infer<typeof inputSchema>;

const DESCRIPTION = [
  "A project's own feedback (FB-n) — what people report or wish about that project's product — for a BA: read it, file it, ask its reporter, and tell them how the work it became is going. Feedback about Forge itself is forge_feedback.",
  'Every list row and get answer carries `progress` for the work the item was routed to (its issues, or the requirement it became; a duplicate reads its root’s): `running` (a run works on it right now), `runs` (unfinished runs: issue, state, step), `waitingOn` (who owes what: a triage, a release act, an answer), `work` (issues total, shipped, awaitingRelease, toDo) and `eta` — {estimate:true, likelyBy (p50), almostSurelyBy (p85), of: hands|landing, basis, confidence}, or {estimate:false, done, why} saying why no date can be given (not triaged yet, declined, answered, routed to a revision, no issue yet).',
  '`progress.says` is the block in one paragraph: tell it to the person, and never give a date the block does not hold.',
  'Actions.',
  'list {phase?: [new|triaged|planned|resolved|reopened|verified|declined], q?, requirement? (REQ-n)}: the items with phase, route, whom each waits on, and progress.',
  'get {feedback}: one in full — body, where seen, route and carriers, decisions, the open clarification and its answer, progress. NOT_FOUND when the project holds no such key.',
  'progress {feedback}: the progress block alone.',
  'similar {feedback}: the items nearest it, to spot a duplicate; not_embedded, provider_not_configured, failed or withheld_by_policy does not mean none is similar.',
  `submit ${CREATE_FEEDBACK_SHAPE}: file it as the person you speak for, at phase new. Name exactly one target; a requirement it touches is best (find it with forge_requirements).`,
  'clarify {feedback, prompt, needed}: ask the reporter one question; `needed` says what would settle it. Refused while one is open, or when the item is past triage.',
  'Triage, decline, verify and retarget are a person’s acts on the Feedback page; this tool does none of them. Issues are never filed from here: triage routes an item to its work.',
  'A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and writes nothing: tell the person the detail.',
].join(' ');

const GRANT = {
  byAction: {
    list: 'projects:read',
    get: 'projects:read',
    progress: 'projects:read',
    similar: 'projects:read',
    submit: 'projects:write',
    clarify: 'projects:write',
  },
} as const;

const actorOf = (ctx: McpContext) => ({
  userId: ctx.principal.userId,
  agency: principalAgency(ctx.principal),
});

function need<K extends keyof Input>(input: Input, field: K, why: string): NonNullable<Input[K]> {
  const value = input[field];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${String(field)} is required for ${input.action}: ${why}`);
  }
  return value as NonNullable<Input[K]>;
}

/** Every item of the project as the door may show it; a refusal leaves as one. */
async function itemsOf(
  ctx: McpContext,
  projectId: string,
  query: Parameters<typeof listFeedbackAs>[2],
) {
  const out = await listFeedbackAs(actorOf(ctx), projectId, query, MCP_DOOR);
  if (!out.ok) return { refused: refusedAnswer(out.refusals, 'FEEDBACK_REFUSED') } as const;
  return { list: out.list } as const;
}

async function readsOf(
  ctx: McpContext,
  projectId: string,
  all: readonly FeedbackSummary[],
): Promise<FeedbackReads> {
  const actor = actorOf(ctx);
  const viewer = await forecastViewerOf(projectId, actor.userId);
  const [forecasts, runs, reqIds] = await Promise.all([
    readFeedbackForecasts(actor, projectId, viewer),
    liveRunsByIssue(projectId, actor.userId),
    requirementIdsOf(projectId, routedRequirements(all)),
  ]);
  const issues = await issuesOfRequirements(projectId, [...reqIds.values()]);
  return {
    asOf: forecasts.asOf,
    forecasts: new Map(forecasts.items.map((f) => [f.key, f])),
    runs,
    requirementIssues: new Map([...reqIds].map(([key, id]) => [key, issues.get(id) ?? []])),
    items: new Map(all.map((s) => [s.key, s])),
  };
}

async function list(ctx: McpContext, projectId: string, input: Input) {
  const filtered = input.phase !== undefined || input.q !== undefined || !!input.requirement;
  const shown = await itemsOf(ctx, projectId, {
    phases: input.phase,
    q: input.q,
    requirement: input.requirement,
  });
  if ('refused' in shown) return shown.refused;
  const all = filtered ? await itemsOf(ctx, projectId, {}) : shown;
  if ('refused' in all) return all.refused;
  const reads = await readsOf(ctx, projectId, all.list.feedback);
  const feedback = shown.list.feedback.map((s) => feedbackRow(s, feedbackProgress(s, reads)));
  return {
    feedback,
    returned: feedback.length,
    counts: shown.list.counts,
    sensitive: shown.list.sensitive,
    asOf: reads.asOf,
  };
}

async function readOne(ctx: McpContext, projectId: string, key: string) {
  const [view, all] = await Promise.all([
    detailAs(actorOf(ctx), projectId, key, MCP_DOOR),
    itemsOf(ctx, projectId, {}),
  ]);
  if ('refused' in all) return { refused: all.refused } as const;
  const reads = await readsOf(ctx, projectId, all.list.feedback);
  return { item: feedbackDetail(view, feedbackProgress(view, reads)) } as const;
}

async function get(ctx: McpContext, projectId: string, input: Input) {
  const one = await readOne(ctx, projectId, need(input, 'feedback', 'the item key, FB-n'));
  return 'refused' in one ? one.refused : { feedback: one.item };
}

async function progress(ctx: McpContext, projectId: string, input: Input) {
  const one = await readOne(ctx, projectId, need(input, 'feedback', 'the item key, FB-n'));
  if ('refused' in one) return one.refused;
  const { key, title, phase } = one.item;
  return { key, title, phase, progress: one.item.progress };
}

async function similar(ctx: McpContext, projectId: string, input: Input) {
  const key = need(input, 'feedback', 'the item key, FB-n');
  return similarFeedbackAs(actorOf(ctx), projectId, key, MCP_DOOR);
}

/** The written item as get reads it, or the refusal that wrote nothing. */
async function written(
  ctx: McpContext,
  projectId: string,
  outcome: Awaited<ReturnType<typeof createFeedback>>,
) {
  if (!outcome.ok) return refusedAnswer(outcome.refusals, 'FEEDBACK_REFUSED');
  const one = await readOne(ctx, projectId, outcome.feedback.key);
  if ('refused' in one) return one.refused;
  return { ...(outcome.created ? { created: true } : {}), feedback: one.item };
}

async function submit(ctx: McpContext, projectId: string, input: Input) {
  const {
    action: _a,
    projectId: _p,
    feedback: _f,
    phase: _ph,
    q: _q,
    prompt,
    needed,
    ...rest
  } = input;
  if (prompt !== undefined || needed !== undefined) {
    throw new Error('BAD_REQUEST: prompt and needed belong to clarify, not submit');
  }
  const request = createFeedbackRequestSchema.safeParse(rest);
  if (!request.success) {
    throw new Error(
      `BAD_REQUEST: submit takes ${CREATE_FEEDBACK_SHAPE}; ${request.error.issues
        .map((i) => `${i.path.join('.') || '/'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return written(
    ctx,
    projectId,
    await createFeedback({ projectId, actor: actorOf(ctx), request: request.data }),
  );
}

async function clarify(ctx: McpContext, projectId: string, input: Input) {
  const ref = need(input, 'feedback', 'the item key, FB-n');
  const body = feedbackClarificationRequestSchema.safeParse({
    prompt: input.prompt,
    needed: input.needed,
  });
  if (!body.success) {
    throw new Error(
      `BAD_REQUEST: clarify takes { feedback, prompt (5-2000 chars), needed (3-1000 chars) }; ${body.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return written(
    ctx,
    projectId,
    await askClarification({ projectId, ref, actor: actorOf(ctx), ...body.data }),
  );
}

const HANDLERS = { list, get, progress, similar, submit, clarify } as const;

export const projectFeedbackMcpTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'project_feedback',
  reach: 'project',
  route: '/api/projects',
  grant: GRANT,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    return HANDLERS[input.action](ctx, projectId, input);
  },
});
