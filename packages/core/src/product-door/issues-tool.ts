// `forge_issues`: delivery work as a person following it reads it — what is being built, how far it
// has got, whether an agent is on it now and when it is likely done. It reads; it files nothing. An
// issue is the delivery side, born from a requirement's breakdown or from triaged feedback, so an MCP
// client that reaches for `create` is refused by name and told where the record it means goes.

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueCreateRefusalCode } from '@forge/contracts/issues';
import { ISSUES_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { z } from 'zod';
import { readIssueForecast, readProjectForecast } from '../forecast/index.js';
import { activeIssuePrefix, listIssues, resolveIssueRouteRef } from '../issues/index.js';
import { egressAs } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { readQuestionsForIssue } from '../questions/index.js';
import { need, parseArgs } from './args.js';
import { forecastViewerOf, readAccess, readerOf } from './context.js';
import { issueProgress } from './progress.js';
import { agentStatesOf } from './work.js';

const LIST_MAX = 100;

/**
 * What an MCP client is told when it reaches for an issue: issues come from the product record, and
 * where the thing it meant to file goes instead. The refusal and the tool's description both say it.
 */
export const ISSUE_CREATE_STEER =
  'An MCP client files no issue. Issues are the delivery side: Forge files one only when a ' +
  "requirement's breakdown is accepted, or when feedback is triaged as delivery work, so the " +
  'product record always leads. Record what the person means instead, after they confirm it: ' +
  '(1) a problem, bug, change or idea someone reported is Feedback (project_feedback; kind bug | ' +
  'change_request | idea | question), linked to the requirement it touches, and its triage files ' +
  'the issue; (2) new or changed behaviour is a Requirement or a revision of one ' +
  '(forge_requirements), and accepting its breakdown (forge_design suggestion_accept) files the ' +
  'issues, so read every slice first; (3) a question about work already under way is ' +
  'forge_questions ask on that issue. When to step in: ask the person before recording anything, ' +
  'and never accept a breakdown or a triage on your own: each files delivery work, so the person ' +
  'decides it. Work so urgent it fits none of these is filed by the person in the Forge web app, ' +
  'not from here.';

const refuseCreate = refuser<IssueCreateRefusalCode>('ISSUE_CREATE_REFUSED');

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
});
type Input = z.infer<typeof input>;

const SHAPE = '{ action, projectId, issue?, status?, statusNot?, search?, limit?, offset? }';

const DESCRIPTION = `Delivery work as a person following it reads it: each issue's status, whether an agent is working on it now, and when it is likely done (the forecast's dates, or plainly why there is none). It reads; it files nothing.
- action=list { projectId, status?, statusNot?, search?, limit?, offset? }: issues most recently changed first, each with key, title, status, priority and \`progress\`. \`pause\` names a wait that holds the whole project, such as no runner online.
- action=get { projectId, issue }: one issue with its description, the questions it waits on, and \`progress\`.
- action=create: refused (MCP_FILES_FEEDBACK_NOT_ISSUES). ${ISSUE_CREATE_STEER}`;

async function list(ctx: McpContext, i: Input) {
  const access = await readAccess(ctx, i.projectId);
  const listed = await listIssues(
    i.projectId,
    { status: i.status, statusNot: i.statusNot, search: i.search },
    { sort: 'updatedAt:desc', limit: i.limit ?? 25, offset: i.offset ?? 0 },
  );
  if (!listed.ok) throw new Error(`BAD_REQUEST: ${listed.field}: ${listed.message}`);
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
  const access = await readAccess(ctx, i.projectId);
  const row = await resolveIssueRouteRef(ref, i.projectId, ctx.principal.userId);
  if (row.projectId !== i.projectId) {
    throw new Error(`NOT_FOUND: issue ${ref} is not an issue of project ${i.projectId}`);
  }
  const out = await egressAs(readerOf(ctx), i.projectId, 'issue', row, ref);
  if (!out.ok) throw new RefusalError([out.refusal], out.refusal.code);
  const issue = out.value;
  const [prefix, forecast, agents, questions] = await Promise.all([
    activeIssuePrefix(i.projectId),
    readIssueForecast(i.projectId, issue.issSeq, forecastViewerOf(ctx, access)),
    agentStatesOf(i.projectId, [issue.id]),
    readQuestionsForIssue(issue.id, ctx.principal.userId),
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
  };
}

function create(): never {
  throw refuseCreate('MCP_FILES_FEEDBACK_NOT_ISSUES', ISSUE_CREATE_STEER, '/action');
}

export const forgeIssuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_issues',
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(input),
  reach: { byAction: { list: 'project', get: 'project', create: 'public' } },
  route: ['/api/projects', '/api/issues'],
  grant: {
    byAction: {
      list: 'projects:read',
      get: 'issues:read',
      create: { none: 'it writes nothing and reads nothing: it answers how an issue comes to be' },
    },
  },
  // `create` is answered before the arguments are read, so whatever fields a client sends with it
  // (a title, a description, the retired tool's `data`) it meets the steering, not a schema error
  handler: async (args) => {
    if (args.action === 'create') create();
    const i = parseArgs(input, args, SHAPE);
    if (i.action === 'list') return list(ctx, i);
    if (i.action === 'get') return get(ctx, i);
    return create();
  },
});
