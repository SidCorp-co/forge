// `forge_issues`: delivery work as a person following it reads it — what is being built, how far it
// has got, whether an agent is on it now and when it is likely done — and the filing of one, by the
// same create every other door takes (ISS-861: the client judges where a record belongs, and the
// kernel's own refusals still hold: project.write, the edges). An issue filed here is born at `draft`
// and the master admits it: no person admits an issue (REQ-68 BC-6), so the door takes no `admit`.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { ISSUE_FILING_LANE, ISSUES_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
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
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { argumentRefusal, need, readingArgument } from '../lib/tool-args.js';
import { onArg } from '../permissions/index.js';
import { readQuestionsForIssue } from '../questions/index.js';
import { issueRequirementOf } from '../requirements/index.js';
import { parseArgs } from './args.js';
import { actorOf, projectAccess, readerOf } from './context.js';
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
  acceptanceCriteria: issueCreateSchema.shape.acceptanceCriteria.describe(
    'create: its criteria on the record, numbered lines `1. …`; a list only in the description is none',
  ),
});
type Input = z.infer<typeof input>;

const SHAPE =
  '{ action, projectId, issue?, status?, statusNot?, search?, limit?, offset?, title?, description?, priority?, category?, relations?, acceptanceCriteria? }';

const DESCRIPTION = `Delivery work as a person following it reads it: each issue's status, whether an agent is working on it now, and when it is likely done (the forecast's dates, or plainly why there is none), and the filing of one. No door here admits, moves or links an issue: the project's master does.
- action=list { projectId, status?, statusNot?, search?, limit?, offset? }: issues most recently changed first (with \`search\`, the issues \`find\` keeps for those words, in its order), each with key, title, status, priority and \`progress\`. \`pause\` names a wait that holds the whole project, such as no runner online.
- action=get { projectId, issue }: one issue with its description, the questions it waits on, \`progress\`, and \`requirement\`: the requirement it delivers, whichever project of its organization holds it (\`otherProject\` names a sibling's), at its current revision with its spec, its criteria (code and body) and its latest agreed baseline; null where it delivers none.
- action=create { projectId, title, description?, priority?, category?, relations?, acceptanceCriteria? }: files an issue as you, the way any other door does: it needs project.write, is born at \`draft\`, where the project's master admits it (no person admits an issue), and answers its key. ${ISSUE_FILING_LANE} Name in its description what it delivers. Its criteria go in \`acceptanceCriteria\`: a list only in the description is no criterion, and the answer's \`warnings\` says so.`;

async function list(ctx: McpContext, i: Input) {
  await projectAccess(ctx, i.projectId);
  const listed = await listIssues(
    i.projectId,
    { status: i.status, statusNot: i.statusNot, search: i.search },
    // a search reads in the find door's order (ISS-1256), a plain list most recently changed first
    { sort: i.search ? undefined : 'updatedAt:desc', limit: i.limit ?? 25, offset: i.offset ?? 0 },
  );
  if (!listed.ok) throw argumentRefusal(`/${listed.field}`, listed.message);
  const out = await egressAs(readerOf(ctx), i.projectId, 'issue', listed.rows, 'the issue list');
  if (!out.ok) throw new RefusalError([out.refusal], out.refusal.code);
  const rows = out.value;
  const [prefix, forecast, agents] = await Promise.all([
    activeIssuePrefix(i.projectId),
    readProjectForecast(i.projectId),
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
  await projectAccess(ctx, i.projectId);
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
    readIssueForecast(i.projectId, issue.issSeq),
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
      acceptanceCriteria: i.acceptanceCriteria,
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
    warnings: [...result.bodyWarnings, ...(result.criteriaWarning ? [result.criteriaWarning] : [])],
  };
}

/** One create describe answers as written (REQ-78 BC-3). */
const DESCRIBE = {
  create: {
    example: {
      projectId: '<project uuid>',
      title: 'Reorder fills the cart with a past order’s items',
      description: 'Delivers the reorder requirement’s first criterion.',
      acceptanceCriteria: '1. A past order’s page offers Reorder, which fills the cart.',
    },
  },
} as const;

/** When a person's client reaches for the issue door (ISS-1251), from how product roles used it. */
const CARDS = {
  list: {
    purpose:
      'Lists delivery work with each issue’s status and whether it runs and when it is likely done.',
    situations: [
      {
        when: 'a person asks what is being built now, or what is stuck, in a project',
        do: 'list it with statusNot closed and dropped, and tell them each `progress.says`',
      },
      {
        when: 'you look for the issue a person names in their own words, not by key',
        do: 'list with search on their words and confirm the match with them by its title',
      },
    ],
    practice: [
      'Repeat `progress.says` and a `pause`, never a date the forecast does not hold.',
      'For how the project stands overall, project.status reads it in one call.',
    ],
    example: { projectId: '<project uuid>', statusNot: ['closed', 'dropped'], limit: 25 },
    redFlag:
      'Reading closed as live: an issue closes when its criteria are met, and whether it is live is the release record’s.',
    family: 'product.status',
    audience: ['person'],
    scenarios: ['issue keys sent as ISS602, #602 and ISS-602x: ISS-891'],
  },
  get: {
    purpose:
      'Reads one issue: what it delivers, the questions it waits on, and when it is likely done.',
    situations: [
      {
        when: 'a person asks where one piece of work stands, or why it waits',
        do: 'get it by its key and tell them `progress.says` and each open question it waits on',
      },
      {
        when: 'you need the requirement and criteria an issue delivers before you judge or revise it',
        do: 'get it and read `requirement`, which names a sibling project’s requirement too',
      },
    ],
    practice: ['Name the issue by its key exactly, ISS-12, or by its uuid.'],
    example: { projectId: '<project uuid>', issue: 'ISS-12' },
    // ISS-891: `ISS602`, `#602` and `ISS-602x` were sent as keys and refused
    redFlag:
      'Sending a key in another shape (ISS602, #602): it is refused at /issue, not looked up.',
    family: 'product.status',
    audience: ['person'],
    scenarios: ['an issue key sent as ISS602'],
  },
  create: {
    purpose: 'Files delivery work at draft, where the project’s master admits it.',
    situations: [
      {
        when: 'an agreed requirement or a triaged feedback item covers work nobody has filed yet',
        do: 'create it naming what it delivers, its criteria in acceptanceCriteria',
      },
      {
        when: 'you found a technical defect against an existing expectation, a security or performance gap, or debt',
        do: 'create it yourself in its technical lane, saying why it is an issue and not Feedback',
      },
      {
        when: 'a person reports a problem or wants new or changed behaviour',
        do: 'file it as Feedback (project_feedback.submit) or a requirement draft, not an issue',
        watch:
          'an issue filed for a product wish skips the triage that turns it into a requirement',
      },
    ],
    practice: [
      'Choose the lane yourself and say why in the description; a person is never asked before filing.',
      'Put criteria in acceptanceCriteria as numbered lines; a list only in the description is none.',
      'Send a blocks edge in relations with the create, so it cannot dispatch before its blocker.',
    ],
    example: {
      projectId: '<project uuid>',
      title: 'Reorder fills the cart with a past order’s items',
      description: 'Delivers the reorder requirement’s first criterion.',
      acceptanceCriteria: '1. A past order’s page offers Reorder, which fills the cart.',
    },
    // ISS-1183 and ISS-861: clients asked the person before filing; triage-filed issues carried their
    // criteria only in the description (the create answers a warning for it)
    redFlag:
      'Asking the person whether to file, or listing criteria only in the description: the first parks routine work on him, the second leaves the issue with no criterion.',
    family: 'product.status',
    audience: ['person'],
    scenarios: [
      'a client asking the person before filing, criteria left in the description: ISS-1183',
    ],
  },
} satisfies Record<(typeof ISSUES_TOOL_ACTIONS)[number], CapabilityCardBody>;

export const forgeIssuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_issues',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  actionDescribe: DESCRIBE,
  cards: CARDS,
  source: sourceOf(import.meta.url),
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
