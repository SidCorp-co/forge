// forge_requirements: a BA's door onto a project's requirements over /mcp (owner direction
// 2026-10-16: /mcp serves the product layer). Every action is a REST route's own service call —
// GET/POST /api/projects/:id/requirements, …/:req/revisions, …/revisions/:n/propose, …/withdraw, and
// POST /api/questions/:id/answer for a question standing on one — and every read carries the
// progress block (`product-progress.ts`).

import { REQUIREMENT_STATES } from '@forge/contracts/requirements';
import { REQUIREMENT_TITLE_MAX, titleText } from '@forge/contracts/title-text';
import { putCriterionStepsRequestSchema } from '@forge/contracts/workflow-health';
import { z } from 'zod';
import {
  forecastViewerOf,
  readRequirementForecast,
  readRequirementForecasts,
} from '../forecast/index.js';
import { principalAgency } from '../issues/index.js';
import { egressShown, MCP_DOOR } from '../lib/data-egress.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  refusedAnswer,
  zodToMcpSchema,
} from '../lib/tool.js';
import { argumentRefusal, need } from '../lib/tool-args.js';
import { byRule, onResolved, requireDeclaredOn } from '../permissions/index.js';
import { issuesOfRequirements, liveRunsByIssue, runsOn } from '../product-progress/index.js';
import { resolveEffectiveProjectId } from '../projects/index.js';
import {
  designIdNamed,
  draftRequirement,
  linkWorkflow,
  listRequirementsAs,
  proposeRevision,
  putCriterionSteps,
  readRequirementAs,
  revisionFields,
  similarRequirements,
  unlinkWorkflow,
  withdrawRevision,
  writeRevision,
} from '../requirements/index.js';
import { ANSWER_LINE, answerOnRequirement } from './requirement-answer.js';
import { requirementDetail, requirementProgress, requirementRow } from './requirement-views.js';

const ACTIONS = [
  'list',
  'get',
  'progress',
  'similar',
  'create',
  'revise',
  'propose',
  'withdraw',
  'link_design',
  'unlink_design',
  'trace_criterion',
  'answer',
] as const;
const READS = ['list', 'get', 'progress', 'similar'] as const;
export const REQUIREMENT_READ_ACTIONS: readonly string[] = READS;

const requirementKey = z
  .string()
  .regex(/^REQ-\d+$/, 'a requirement is named by its key, REQ-n')
  .describe('the requirement key, e.g. REQ-12');

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z
    .uuid()
    .optional()
    .describe('the project; left out, the X-Forge-Project-Slug header or the token’s one project'),
  requirement: requirementKey.optional(),
  state: z
    .enum(REQUIREMENT_STATES)
    .optional()
    .describe('list: keep only requirements in this state'),
  text: z.string().trim().min(3).max(8_000).optional().describe('similar: the wish to compare'),
  title: titleText(REQUIREMENT_TITLE_MAX)
    .optional()
    .describe('the requirement’s title, in the person’s words'),
  designs: z
    .array(z.string().trim().min(1).max(200))
    .max(10)
    .optional()
    .describe('create: the workflow designs it relates to, by flow name or id; each is linked'),
  baseRevision: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe('revise: the head you read (currentRevision from get), null where it has none'),
  revision: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'revise: the draft revision to rewrite whole; propose: the draft revision to propose; withdraw: the draft revision to withdraw',
    ),
  workflow: putCriterionStepsRequestSchema.shape.workflow
    .optional()
    .describe('link_design, unlink_design, trace_criterion: the design, by flow name or id'),
  code: z
    .string()
    .regex(/^BC-[1-9][0-9]*$/, 'a criterion is named by its code, BC-n')
    .optional()
    .describe('trace_criterion: the criterion’s code, e.g. BC-2'),
  steps: putCriterionStepsRequestSchema.shape.steps.describe(
    'trace_criterion: the step ids of the design it is traced onto; an empty list clears them',
  ),
  edges: putCriterionStepsRequestSchema.shape.edges.describe(
    'trace_criterion: the edges, each { from, to, label? }; an empty list clears them',
  ),
  questionId: z.uuid().optional().describe('answer: a question standing on the requirement'),
  round: z.number().int().optional().describe('answer: the round being answered'),
  optionId: z.string().optional().describe('answer: the option the person chose'),
  answer: z.string().optional().describe('answer: the person’s words, on a free-text round'),
  ...revisionFields,
  criteria: revisionFields.criteria.optional().describe('the requirement’s criteria'),
});

type Input = z.infer<typeof inputSchema>;

const CRITERIA_TEXT =
  'what must hold for it to be met, each { body, form?, code?, title? }: body is the criterion; form is statement (the default: a sentence a judge finds true or false on the running product) or scenario (the body reads Given …, When …, Then …, each keyword starting a line); title is a row label of at most eight words';

/** Each write action's own field texts and one call it accepts as written (REQ-78 BC-3). */
const DESCRIBE = {
  create: {
    fields: {
      title: 'required: the requirement’s title, in the person’s words',
      criteria: `optional, none when left out: ${CRITERIA_TEXT}. Leave code out: the server gives each the next BC-n`,
      reason:
        'optional: why the person wants it; left out, its author is asked why as a question on it',
      spec: 'optional: { goal?, personas?, scopeIn?, scopeOut?, openQuestions?, assumptions? }',
      tldr: 'optional: the requirement in a sentence or two',
      kind: 'optional: process, rule, screen or report; its picture follows from it',
      picture:
        'optional: a rough sketch of the kind kind names (flow, example_table, wireframe or chart); leave alt out',
      designs: 'optional: the workflow designs it relates to, by flow name or id; each is linked',
      writtenLang: 'optional: the language the title and criteria are written in; left out, yours',
    },
    example: {
      projectId: '<project uuid>',
      title: 'A customer can reorder a past order in one tap',
      reason: 'Repeat customers rebuild the same cart by hand every week.',
      criteria: [
        { body: 'A past order’s page offers Reorder, which fills the cart with its items.' },
        {
          form: 'scenario',
          body: 'Given a past order whose items are all in stock\nWhen the customer taps Reorder\nThen the cart holds those items at today’s prices',
        },
      ],
    },
  },
  revise: {
    fields: {
      title:
        'optional: the new title it gives once a person accepts the revision; left out, the head’s is carried',
      criteria: `required, the WHOLE list: ${CRITERIA_TEXT}. A criterion that stays keeps its code; a new one has none and is given the next BC-n; one left out is retired`,
      baseRevision:
        'the head you read (currentRevision from get), null where it has none; or send revision instead',
      revision: 'optional: the draft revision to rewrite whole, in place of baseRevision',
    },
    example: {
      projectId: '<project uuid>',
      requirement: 'REQ-12',
      baseRevision: 1,
      criteria: [
        {
          code: 'BC-1',
          body: 'A past order’s page offers Reorder, which fills the cart with its items.',
        },
      ],
    },
  },
} as const;

const DESCRIPTION = [
  "A project's requirements (REQ-n), for a BA: read them, draft and revise them, and tell the person how delivery is going.",
  'Every list row and get answer carries `progress`: `running` (a run works on it right now), `runs` (unfinished runs on its issues: issue, state, step), `waitingOn` (who owes what before it goes on: an agree, a breakdown, a release act; `late` when overdue), `work` (its issues: total, shipped, awaitingRelease, toDo) and `eta` — {estimate:true, likelyBy (p50), almostSurelyBy (p85), of: hands|landing, basis, confidence} read off the project’s own history, or {estimate:false, done, why} saying why no date can be given.',
  '`progress.says` is the block in one paragraph: tell it to the person, and never give a date the block does not hold.',
  'Actions.',
  'list {state?}: every requirement with its state, whom it waits on, criteria proven of total, and progress.',
  'get {requirement}: one in full — its latest revision (spec, criteria with codes), revisions, questions standing on it, its linked designs and each criterion’s trace onto them, issues, releases, linked feedback, progress. NOT_FOUND when the project holds no such key.',
  'progress {requirement}: the progress block alone.',
  'similar {text}: the requirements nearest a wish; call it before create, and revise the one that covers it instead. provider_not_configured or withheld_by_policy does not mean none is similar.',
  'create {title, criteria?, reason?, spec?, tldr?, kind?, picture?, designs?, writtenLang?}: a NEW draft requirement at revision 1, as POST /api/projects/:id/requirements writes it; with no reason its author is asked why. REQUIREMENT_DESIGN_UNKNOWN names a design the project lacks.',
  'revise {requirement, criteria, baseRevision | revision, title?, reason?, spec?, tldr?, changeSummary?, kind?, picture?}: a new draft revision on the head — use it to change an agreed requirement, its title included (title, applied when a person accepts it; there is no other rename). Write the WHOLE criteria list: each criterion that stays keeps its code, a new one has none. REQUIREMENT_REVISION_OPEN: a revision is open. A draft is rewritten by passing revision: n; a proposed one is frozen until a holder of requirements.approve returns or accepts it, which this tool does not, so tell the person. REQUIREMENT_REVISION_STALE: the head moved, get it again.',
  'propose {requirement, revision}: put a draft revision before the people who agree it.',
  'withdraw {requirement, revision, reason}: withdraw an open draft revision for good, saying why, as POST …/revisions/:n/withdraw does: its author may, anyone else needs requirements.approve. It frees the one open revision (REQUIREMENT_REVISION_OPEN) and is the one act left on a dropped requirement (REQUIREMENT_DROPPED).',
  'link_design {requirement, workflow}: link an existing design, by flow name or id, to the requirement, as POST …/requirements/:req/workflows does; its next agree pins the design’s approved revision. NOT_FOUND: the project holds no such design; WORKFLOW_DESIGN_WITHDRAWN: it was withdrawn.',
  'unlink_design {requirement, workflow}: remove that link, and every criterion’s trace onto that design with it, as DELETE …/requirements/:req/workflows/:workflowId does; NOT_FOUND where the requirement links no such design.',
  'trace_criterion {requirement, code, workflow, steps?, edges?}: write criterion code’s WHOLE trace onto a linked design — its step ids and edges { from, to, label? } — as PUT …/requirements/:req/criteria/:code/steps does; empty lists clear it. REQUIREMENT_DESIGN_UNLINKED: link the design first (link_design); WORKFLOW_NODE_UNKNOWN or WORKFLOW_NODE_AMBIGUOUS names a step or edge the design’s latest revision does not hold.',
  ANSWER_LINE,
  'Agreeing, accepting, returning, deferring and dropping are a sign-off this tool does none of: the project’s master’s outside a strict project (it holds requirements.approve there), a person’s on the requirement page in one.',
  'A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and writes nothing: tell the person the detail.',
].join(' ');

const GRANT = {
  byAction: {
    list: 'projects:read',
    get: 'projects:read',
    progress: 'projects:read',
    similar: 'projects:read',
    create: 'projects:write',
    revise: 'projects:write',
    propose: 'projects:write',
    withdraw: 'projects:write',
    link_design: 'projects:write',
    unlink_design: 'projects:write',
    trace_criterion: 'projects:write',
    answer: 'questions:write',
  },
} as const;

// What each action needs, as its REST twin declares it on :id (requirements/routes.ts,
// revision-routes.ts); the project is the projectId argument, else the slug header or the token's
// one project, so the handler resolves it and each service checks with requireDeclaredOn. similar
// has no twin and its service checks nothing, so its handler checks project.read itself. answer
// stays on the amnesty: readRequirementAs and the question-not-on-this-requirement NOT_FOUND come
// before the project.write its twin declares, which a resolved declaration would check first
const THE_PROJECT =
  "the projectId argument, else the X-Forge-Project-Slug header or the token's one project";
const PERMISSION = {
  byAction: {
    list: onResolved('project.read', THE_PROJECT),
    get: onResolved('project.read', THE_PROJECT),
    progress: onResolved('project.read', THE_PROJECT),
    similar: onResolved('project.read', THE_PROJECT),
    create: onResolved('project.write', THE_PROJECT),
    revise: onResolved('project.write', THE_PROJECT),
    propose: onResolved('project.write', THE_PROJECT),
    withdraw: onResolved('project.write', THE_PROJECT),
    link_design: onResolved('project.write', THE_PROJECT),
    unlink_design: onResolved('project.write', THE_PROJECT),
    trace_criterion: onResolved('project.write', THE_PROJECT),
    answer: byRule(
      'requirements/read.ts:readRequirementAs',
      'the requirement is read as the caller and the question found on it, each not found otherwise, before project.write',
    ),
  },
} as const;

const actorOf = (ctx: McpContext) => ({
  userId: ctx.principal.userId,
  agency: principalAgency(ctx.principal),
});

async function list(ctx: McpContext, projectId: string, input: Input) {
  const actor = actorOf(ctx);
  const [rows, viewer, runs] = await Promise.all([
    listRequirementsAs(actor, projectId),
    forecastViewerOf(projectId, actor.userId),
    liveRunsByIssue(projectId, actor.userId),
  ]);
  const shown = input.state ? rows.filter((r) => r.standing.state === input.state) : rows;
  const [forecasts, issues] = await Promise.all([
    readRequirementForecasts(projectId, viewer),
    issuesOfRequirements(
      projectId,
      shown.map((r) => r.id),
    ),
  ]);
  const scopes = new Map(forecasts.requirements.map((s) => [s.key, s]));
  const requirements = shown.map((r) => {
    const keys = (issues.get(r.id) ?? []).map((i) => i.key);
    const progress = requirementProgress(
      r,
      scopes.get(r.key) ?? null,
      runsOn(runs, keys),
      forecasts.asOf,
    );
    return requirementRow(r, progress);
  });
  return egressShown(
    projectId,
    'requirement',
    { requirements, returned: requirements.length, asOf: forecasts.asOf },
    'the requirement list',
  );
}

/** One requirement as get reads it, with its progress; NOT_FOUND where the project holds no such key. */
async function readOne(ctx: McpContext, projectId: string, key: string) {
  const actor = actorOf(ctx);
  const [detail, viewer, runs] = await Promise.all([
    readRequirementAs(actor, projectId, key, MCP_DOOR),
    forecastViewerOf(projectId, actor.userId),
    liveRunsByIssue(projectId, actor.userId),
  ]);
  const scope = await readRequirementForecast(
    projectId,
    Number(detail.key.slice('REQ-'.length)),
    viewer,
  );
  const keys = detail.issues.filter((i) => i.status !== 'dropped').map((i) => i.displayId);
  const progress = requirementProgress(
    detail,
    scope,
    runsOn(runs, keys),
    scope?.asOf ?? new Date().toISOString(),
  );
  return requirementDetail(detail, progress);
}

async function get(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: key } = need(input, input.action, 'requirement');
  return { requirement: await readOne(ctx, projectId, key) };
}

async function progress(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: key } = need(input, input.action, 'requirement');
  const one = await readOne(ctx, projectId, key);
  return { key: one.key, title: one.title, state: one.state, progress: one.progress };
}

async function similar(ctx: McpContext, projectId: string, input: Input) {
  const { text } = need(input, input.action, 'text');
  await requireDeclaredOn(projectId, ctx.principal.userId, 'project.read');
  return similarRequirements(projectId, text, 'conversation');
}

/** The written requirement as get reads it, or the refusal that wrote nothing. */
async function written(
  ctx: McpContext,
  projectId: string,
  outcome: Awaited<ReturnType<typeof writeRevision>>,
) {
  if (!outcome.ok) return refusedAnswer(outcome.refusals, 'REQUIREMENT_REFUSED');
  return {
    ...(outcome.created ? { created: true } : {}),
    requirement: await readOne(ctx, projectId, outcome.requirement.key),
  };
}

async function create(ctx: McpContext, projectId: string, input: Input) {
  const { title } = need(input, input.action, 'title');
  const { reason, spec, kind, picture, tldr, changeSummary, writtenLang } = input;
  const write = {
    reason,
    spec,
    kind,
    picture,
    tldr,
    changeSummary,
    writtenLang,
    criteria: input.criteria ?? [],
  };
  return written(
    ctx,
    projectId,
    await draftRequirement({
      projectId,
      actor: actorOf(ctx),
      title,
      write,
      designs: input.designs ?? [],
    }),
  );
}

async function revise(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: ref, criteria } = need(input, input.action, 'requirement', 'criteria');
  const { title, reason, spec, kind, picture, tldr, changeSummary, writtenLang } = input;
  const write = { title, reason, spec, kind, picture, tldr, changeSummary, writtenLang, criteria };
  const actor = actorOf(ctx);
  if (input.revision !== undefined) {
    return written(
      ctx,
      projectId,
      await writeRevision({ projectId, ref, actor, revision: input.revision, write }),
    );
  }
  if (input.baseRevision === undefined) {
    throw argumentRefusal(
      '/baseRevision',
      'action revise needs baseRevision, or revision: n to rewrite a draft',
    );
  }
  return written(
    ctx,
    projectId,
    await writeRevision({ projectId, ref, actor, baseRevision: input.baseRevision, write }),
  );
}

async function propose(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: ref, revision } = need(input, input.action, 'requirement', 'revision');
  return written(
    ctx,
    projectId,
    await proposeRevision({ projectId, ref, actor: actorOf(ctx), revision }),
  );
}

async function withdraw(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: ref, revision } = need(input, input.action, 'requirement', 'revision');
  return written(
    ctx,
    projectId,
    await withdrawRevision({
      projectId,
      ref,
      actor: actorOf(ctx),
      revision,
      reason: input.reason ?? '',
    }),
  );
}

async function linkDesign(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: ref, workflow } = need(input, input.action, 'requirement', 'workflow');
  const workflowId = await designIdNamed(projectId, workflow);
  return written(
    ctx,
    projectId,
    await linkWorkflow({ projectId, ref, actor: actorOf(ctx), workflowId }),
  );
}

async function unlinkDesign(ctx: McpContext, projectId: string, input: Input) {
  const { requirement: ref, workflow } = need(input, input.action, 'requirement', 'workflow');
  const workflowId = await designIdNamed(projectId, workflow);
  return written(
    ctx,
    projectId,
    await unlinkWorkflow({ projectId, ref, actor: actorOf(ctx), workflowId }),
  );
}

async function traceCriterion(ctx: McpContext, projectId: string, input: Input) {
  const {
    requirement: ref,
    code,
    workflow,
  } = need(input, input.action, 'requirement', 'code', 'workflow');
  const request = {
    workflow,
    ...(input.steps ? { steps: input.steps } : {}),
    ...(input.edges ? { edges: input.edges } : {}),
  };
  return written(
    ctx,
    projectId,
    await putCriterionSteps({ projectId, ref, code, actor: actorOf(ctx), request }),
  );
}

/** A question standing on the requirement, answered through the question door (requirement-answer.ts). */
async function answer(ctx: McpContext, projectId: string, input: Input) {
  return answerOnRequirement(ctx, actorOf(ctx), projectId, input);
}

const HANDLERS = {
  list,
  get,
  progress,
  similar,
  create,
  revise,
  propose,
  withdraw,
  link_design: linkDesign,
  unlink_design: unlinkDesign,
  trace_criterion: traceCriterion,
  answer,
} as const;

export const forgeRequirementsMcpTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirements',
  reach: 'project',
  route: ['/api/projects', '/api/questions'],
  grant: GRANT,
  permission: PERMISSION,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  actionDescribe: DESCRIBE,
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    return HANDLERS[input.action](ctx, projectId, input);
  },
});
