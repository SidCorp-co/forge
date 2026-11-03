// `forge_issues`: delivery work as a person following it reads it — what is being built, how far it
// has got, whether an agent is on it now and when it is likely done — and the filing of one, by the
// same create every other door takes (ISS-861: the client judges where a record belongs, and the
// kernel's own refusals still hold: project.write, the edges). An issue filed here is born at `draft`
// and the master admits it: no person admits an issue (REQ-68 BC-6), so the door takes no `admit`.

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { ISSUES_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { z } from 'zod';
import { readIssueForecast, readProjectForecast } from '../forecast/index.js';
import {
  activeIssuePrefix,
  createIssue,
  issueCreateSchema,
  listIssues,
  resolveIssueRouteRef,
} from '../issues/index.js';
import { egressAs, egressOr } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { argumentRefusal, need, readingArgument } from '../lib/tool-args.js';
import { onArg } from '../permissions/index.js';
import { readQuestionsForIssue } from '../questions/index.js';
import { issueRequirementOf } from '../requirements/index.js';
import { parseArgs } from './args.js';
import { actorOf, forecastViewerOf, projectAccess, readerOf } from './context.js';
import { issueProgress } from './progress.js';
import { agentStatesOf } from './work.js';

const LIST_MAX = 100;

const input = z.strictObject({
  action: z.enum(ISSUES_TOOL_ACTIONS),
  projectId: z.uuid(),
  issue: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('get: an issue key (ISS-12) or uuid'),
  status: z.array(z.enum(ISSUE_STATUSES)).optional().describe('list: only these statuses'),
  statusNot: z.array(z.enum(ISSUE_STATUSES)).optional().describe('list: none of these statuses'),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(LIST_MAX).optional(),
  offset: z.number().int().min(0).optional(),
  title: issueCreateSchema.shape.title.optional().describe('create: the issue title'),
  description: issueCreateSchema.shape.description,
  priority: issueCreateSchema.shape.priority,
  category: issueCreateSchema.shape.category,
  relations: issueCreateSchema.shape.relations.describe(
    "create: edges filed with it, e.g. [{ kind: 'blocks', dependsOnId }], committed before it can dispatch",
  ),
});
type Input = z.infer<typeof input>;

const SHAPE =
  '{ action, projectId, issue?, status?, statusNot?, search?, limit?, offset?, title?, description?, priority?, category?, relations? }';

const DESCRIPTION = `Delivery work as a person following it reads it: each issue's status, whether an agent is working on it now, and when it is likely done (the forecast's dates, or plainly why there is none), and the filing of one.
- action=list { projectId, status?, statusNot?, search?, limit?, offset? }: issues most recently changed first, each with key, title, status, priority and \`progress\`. \`pause\` names a wait that holds the whole project, such as no runner online.
- action=get { projectId, issue }: one issue with its description, the questions it waits on, \`progress\`, and \`requirement\`: the requirement it delivers, whichever project of its organization holds it (\`otherProject\` names a sibling's), at its current revision with its spec, its criteria (code and body) and its latest agreed baseline; null where it delivers none.
- action=create { projectId, title, description?, priority?, category?, relations? }: files an issue as you, the way any other door does: it needs project.write, is born at \`draft\`, where the project's master admits it (no person admits an issue), and answers its key. An issue is the delivery side, so start from the product: a problem or idea a person reports goes to Feedback (project_feedback.submit), and new or changed behaviour to a Requirement (requirements.create, or requirements.revise for one that exists); their triage and delivery file the issues. File one here directly when it is delivery work someone will build that an agreed requirement or a triaged feedback item already covers, or a defect found while building, and name in its description what it delivers. When the person asks for an issue and the work has no requirement or feedback behind it, or you cannot tell which it is, ask them before filing.`;

async function list(ctx: McpContext, i: Input) {
  const access = await projectAccess(ctx, i.projectId);
  const listed = await listIssues(
    i.projectId,
    { status: i.status, statusNot: i.statusNot, search: i.search },
    { sort: 'updatedAt:desc', limit: i.limit ?? 25, offset: i.offset ?? 0 },
  );
  if (!listed.ok) throw argumentRefusal(`/${listed.field}`, listed.message);
  const out = await egressAs(readerOf(ctx), i.projectId, 'issue', listed.rows, 'the issue list');
  if (!out.ok) throw new RefusalError([out.refusal], out.refusal.code);
  const rows = out.value;
  const [prefix, forecast, agents] = await Promise.all([
    activeIssuePrefix(i.projectId),
    readProjectForecast(i.projectId, forecastViewerOf(ctx, access)),
    agentStatesOf(
      i.projectId,
      rows.map((r) => r.id),
    ),
  ]);
  const byId = new Map(forecast.issues.map((f) => [f.issueId, f.forecast]));
  return {
    total: listed.total,
    returned: rows.length,
    hasMore: (i.offset ?? 0) + rows.length < listed.total,
    pause: forecast.pause
      ? { who: forecast.pause.who, act: forecast.pause.act, reason: forecast.pause.reason }
      : null,
    issues: rows.map((r) => ({
      key: formatIssueRef(prefix, r.issSeq),
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      updatedAt: r.updatedAt,
      progress: issueProgress(byId.get(r.id) ?? null, agents.get(r.id) ?? null),
    })),
  };
}

async function get(ctx: McpContext, i: Input) {
  const { issue: ref } = need(i, 'get', 'issue');
  const access = await projectAccess(ctx, i.projectId);
  const row = await readingArgument('/issue', () =>
    resolveIssueRouteRef(ref, i.projectId, ctx.principal.userId),
  );
  if (row.projectId !== i.projectId) {
    throw new Error(`NOT_FOUND: issue ${ref} is not an issue of project ${i.projectId}`);
  }
  const out = await egressAs(readerOf(ctx), i.projectId, 'issue', row, ref);
  if (!out.ok) throw new RefusalError([out.refusal], out.refusal.code);
  const issue = out.value;
  const [prefix, forecast, agents, questions, delivered] = await Promise.all([
    activeIssuePrefix(i.projectId),
    readIssueForecast(i.projectId, issue.issSeq, forecastViewerOf(ctx, access)),
    agentStatesOf(i.projectId, [issue.id]),
    readQuestionsForIssue(issue.id, ctx.principal.userId),
    issueRequirementOf(issue.id),
  ]);
  const open = (questions ?? []).filter((q) => q.status === 'open');
  return {
    key: formatIssueRef(prefix, issue.issSeq),
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    category: issue.category,
    description: issue.description,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    mergedAt: issue.mergedAt,
    openQuestions: open.map((q) => ({ id: q.id, prompt: q.prompt, blockerKind: q.blockerKind })),
    progress: issueProgress(forecast?.forecast ?? null, agents.get(issue.id) ?? null),
    requirement: await requirementShown(ctx, delivered.requirement),
  };
}

/** The requirement the issue delivers, under its own project's data policy; one withheld says why. */
async function requirementShown(
  ctx: McpContext,
  requirement: Awaited<ReturnType<typeof issueRequirementOf>>['requirement'],
) {
  if (!requirement) return null;
  const out = await egressAs(
    readerOf(ctx),
    requirement.project.id,
    'requirement',
    requirement,
    requirement.displayKey,
  );
  return egressOr(out, {
    key: requirement.key,
    displayKey: requirement.displayKey,
    otherProject: requirement.otherProject,
  });
}

async function create(ctx: McpContext, i: Input) {
  const { title } = need(i, 'create', 'title');
  const actor = actorOf(ctx);
  const result = await createIssue(
    {
      projectId: i.projectId,
      title,
      description: i.description,
      priority: i.priority,
      category: i.category,
      relations: i.relations,
    },
    {
      createdById: actor.userId,
      createdByDeviceId: null,
      createdVia: 'mcp',
      actor: { type: 'user', id: actor.userId, agency: actor.agency },
    },
  );
  if (result.deduped) {
    return { deduped: true, key: result.existingIssueDisplayId, id: result.existingIssueId };
  }
  const prefix = await activeIssuePrefix(i.projectId);
  return {
    key: formatIssueRef(prefix, result.issue.issSeq),
    id: result.issue.id,
    title: result.issue.title,
    status: result.issue.status,
    relations: result.relations,
    warnings: result.bodyWarnings,
  };
}

export const forgeIssuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_issues',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  reach: 'project',
  route: ['/api/projects', '/api/issues'],
  grant: {
    byAction: {
      list: 'projects:read',
      get: 'issues:read',
      create: 'issues:write',
    },
  },
  // the REST twins declare the same on :id (issues/project-issue-routes.ts)
  permission: {
    byAction: {
      list: onArg('project.read'),
      get: onArg('project.read'),
      create: onArg('project.write'),
    },
  },
  handler: async (args) => {
    const i = parseArgs(input, args, SHAPE);
    if (i.action === 'list') return list(ctx, i);
    if (i.action === 'get') return get(ctx, i);
    return create(ctx, i);
  },
});
