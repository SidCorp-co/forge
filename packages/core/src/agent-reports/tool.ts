import {
  AGENT_REPORT_LIMITS,
  AGENT_REPORT_TRIAGE_ACTS,
  AGENT_REPORT_TRIAGES,
  TRIAGE_AGENT_REPORT_SHAPE,
  type TriageAgentReportRequest,
  triageAgentReportRequestSchema,
} from '@forge/contracts/agent-reports';
import { eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentReportKinds,
  agentReportSeverities,
  agentReports,
  agentReportTargets,
} from '../db/schema.js';
import { principalAgency } from '../issues/index.js';
import { resolvePipelineContext } from '../jobs/index.js';
import { env } from '../lib/env.js';
import { buildListEnvelope, overfetch } from '../lib/list-envelope.js';
import {
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  type McpContext,
  patEffectiveProjectIds,
  refusedAnswer,
  zodToMcpSchema,
} from '../lib/tool.js';
import { markUntrusted, sanitizeUntrusted, stripFrameTokens } from '../lib/untrusted-text.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  listVisibleProjectsWithRole,
  resolveEffectiveProjectId,
  type VisibleProjectWithRole,
} from '../projects/index.js';
import {
  countReportsForJob,
  fireOfSession,
  insertReport,
  listReports,
  readReport,
  reportViews,
  visibleIssue,
  writableProjectIds,
} from './service.js';
import { triageReports } from './triage.js';

const inputSchema = z
  .object({
    action: z.enum(['submit', 'list', 'triage', 'get']),
    projectId: z.uuid().optional(),
    scope: z.enum(['project', 'all']).optional(),
    reportId: z.uuid().optional(),
    act: z.enum(AGENT_REPORT_TRIAGE_ACTS).optional(),
    issue: z.uuid().optional(),
    createIssue: z
      .object({
        title: z.string().min(1).max(AGENT_REPORT_LIMITS.title).optional(),
        description: z.string().max(AGENT_REPORT_LIMITS.description).optional(),
      })
      .strict()
      .optional(),
    reason: z.string().max(AGENT_REPORT_LIMITS.reason).optional(),
    duplicateOf: z.uuid().optional(),
    signalKey: z.string().max(500).optional(),
    // submit fields
    kind: z.enum(agentReportKinds).optional(),
    severity: z.enum(agentReportSeverities).optional(),
    target: z.enum(agentReportTargets).optional(),
    targetRef: z.string().max(500).optional(),
    summary: z.string().min(1).max(2000).optional(),
    detail: z.string().max(5000).optional(),
    suggestion: z.string().max(2000).optional(),
    // list filters
    filters: z
      .object({
        kind: z.enum(agentReportKinds).optional(),
        target: z.enum(agentReportTargets).optional(),
        severity: z.enum(agentReportSeverities).optional(),
        triage: z.enum(AGENT_REPORT_TRIAGES).optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

type ReportRow = {
  summary: string;
  detail: string | null;
  suggestion: string | null;
  targetRef: string | null;
  triageReason: string | null;
};

// Untrusted-framing shared by list and get: agent-submitted text must be
// framed as DATA, not instructions.
function frameReport<T extends ReportRow>(r: T): T {
  return {
    ...r,
    summary: markUntrusted(r.summary, { source: 'agent_report.summary' }),
    detail: r.detail ? markUntrusted(r.detail, { source: 'agent_report.detail' }) : null,
    suggestion: r.suggestion
      ? markUntrusted(r.suggestion, { source: 'agent_report.suggestion' })
      : null,
    targetRef: r.targetRef
      ? markUntrusted(r.targetRef, { source: 'agent_report.targetRef' })
      : null,
    triageReason: r.triageReason
      ? markUntrusted(r.triageReason, { source: 'agent_report.triageReason' })
      : null,
  };
}

function buildSignalKey(
  target: string,
  targetRef: string | null | undefined,
  kind: string,
): string {
  const safeRef = targetRef ? stripFrameTokens(sanitizeUntrusted(targetRef)) : '-';
  return `self_report:${target}:${safeRef}:${kind}`;
}

const DESCRIPTION =
  'Submit, list, get, or triage agent friction reports. ' +
  'action=submit: report friction, skill gaps, unclear steps, or learnings mid-run. ' +
  'Pipeline context (issueId/runId/jobId/stage) is resolved server-side from your active job — do NOT supply it; a report filed from a scheduled run also carries scheduleRunId, the fire that ran it. ' +
  'Required fields: projectId, kind, target, summary. ' +
  'projectId names the project the report is ABOUT, which need not be the one you are working in; it is REQUIRED and never inferred, because a report filed into the wrong feed is never read (`GET /api/projects` prints it beside each slug). ' +
  'Optional: severity (default low), targetRef, detail, suggestion. ' +
  'Returns {ok:true,id,signalKey} on success; {ok:false,reason:"rate_limited"} when the per-job cap is hit (not a 500 — agent continues). ' +
  'action=list: read the friction feed. Supports filters.kind/target/severity/triage (new | filed | dismissed | duplicate), limit (default 25, fleet default 50). ' +
  'scope="project" (default) reads the resolved project; scope="all" unions every project you own or are a member of and adds projectId/projectSlug to each row. ' +
  'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete. `truncated:true` + `truncatedBy` say which cap bit (your limit, or the hard response-size cap). ' +
  'action=get: fetch one report by reportId, resolving its project from the row itself — no projectId needed. NOT_FOUND if missing or not visible to you. ' +
  'Every report carries triage (new | filed | dismissed | duplicate) with triagedBy, triagedAt and triageReason; a filed one has exactly one target, linkedIssueId or `feedback` { key, phase, route } (promote with `POST /api/projects/:id/feedback/promote`, which files it). ' +
  'action=triage: decide what a report is, with act: ' +
  "file (exactly one of issue: <uuid of an issue in any project you can see> | createIssue: { title?, description? }, which creates the issue at draft in the report's project with the report as its evidence) · " +
  'dismiss (reason REQUIRED: AGENT_REPORT_DISMISS_REASON_REQUIRED) · duplicate (duplicateOf: an earlier report of the same project, else AGENT_REPORT_DUPLICATE_UNKNOWN; reason?) · reopen (back to new; AGENT_REPORT_NOT_TRIAGED when it is new already, AGENT_REPORT_PROMOTED when it became feedback). ' +
  'A report is triaged once: a second file, dismiss or duplicate is AGENT_REPORT_ALREADY_TRIAGED naming who triaged it and how — reopen it first. ' +
  'reportId triages one report (projectId resolves which project it must sit in). signalKey triages every report sharing it — add scope="all" for every project you can see (scope="all" without signalKey is a BAD_REQUEST; createIssue needs scope project). ' +
  'A bulk act moves the reports it applies to (file, dismiss and duplicate move the new ones, reopen the triaged ones) and lists the others under `untouched`; N reports of one defect fold into ONE issue in a single call. ' +
  'Returns { effect: { act, triage, reports, issue: { id, key, created } | null, untouched } }.';

// The grant strings keep the `feedback` resource name issued tokens store (credentials/pat-permissions.ts).
const GRANT = {
  byAction: {
    submit: 'feedback:write',
    list: 'feedback:read',
    triage: 'feedback:write',
    get: 'feedback:read',
  },
} as const;

type Input = z.infer<typeof inputSchema>;

async function submit(ctx: McpContext, input: Input) {
  if (!input.projectId) {
    throw new Error(
      'BAD_REQUEST: projectId is required for submit — a report is filed against the project whose defect it describes, and the server will not guess which that is. ' +
        'Pass the projectId of the project this report is ABOUT (not necessarily the one you are working in); `GET /api/projects` prints it beside each slug.',
    );
  }
  const projectId = input.projectId;
  await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(projectId));
  if (!input.kind) throw new Error('BAD_REQUEST: kind is required for submit');
  if (!input.target) throw new Error('BAD_REQUEST: target is required for submit');
  if (!input.summary) throw new Error('BAD_REQUEST: summary is required for submit');

  const resolved = await resolvePipelineContext(ctx.principal);
  const active = resolved.ok ? resolved.context : null;
  const jobId = active?.jobId ?? null;
  const sessionId = active?.agentSessionId ?? null;
  const scheduleRunId = await fireOfSession(sessionId);
  // Per-job rate-limit (server-enforced). Interactive callers (no jobId)
  // have no pipeline run to cap by; skip the check.
  if (jobId) {
    const limit = env.FEEDBACK_MAX_PER_JOB;
    if ((await countReportsForJob(jobId)) >= limit)
      return { ok: false, reason: 'rate_limited', limit };
  }
  const signalKey = buildSignalKey(input.target, input.targetRef, input.kind);
  const insertedId = await insertReport({
    projectId,
    issueId: active?.issueId ?? undefined,
    runId: active?.runId ?? undefined,
    jobId: jobId ?? undefined,
    stage: active?.stage ?? undefined,
    kind: input.kind,
    severity: input.severity ?? 'low',
    target: input.target,
    targetRef: input.targetRef ?? undefined,
    summary: input.summary,
    detail: input.detail ?? undefined,
    suggestion: input.suggestion ?? undefined,
    signalKey,
    sessionId: sessionId ?? undefined,
    scheduleRunId: scheduleRunId ?? undefined,
  });
  if (!insertedId) throw new Error('forge_agent_report: insert returned no row');
  return { ok: true, id: insertedId, signalKey };
}

async function list(ctx: McpContext, input: Input) {
  const f = input.filters ?? {};
  let scopeCondition: SQL;
  let limit: number;
  if (input.scope === 'all') {
    const visibleIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
    if (visibleIds.length === 0)
      return { reports: [], returned: 0, limit: input.limit ?? 50, hasMore: false };
    scopeCondition = inArray(agentReports.projectId, visibleIds);
    limit = input.limit ?? 50;
  } else {
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(projectId));
    scopeCondition = eq(agentReports.projectId, projectId);
    limit = input.limit ?? 25;
  }
  const rows = await listReports(
    [
      scopeCondition,
      f.kind ? eq(agentReports.kind, f.kind) : undefined,
      f.target ? eq(agentReports.target, f.target) : undefined,
      f.severity ? eq(agentReports.severity, f.severity) : undefined,
      f.triage ? eq(agentReports.triage, f.triage) : undefined,
    ],
    overfetch(limit),
  );
  return buildListEnvelope({
    key: 'reports',
    items: (await reportViews(rows)).map((r) => frameReport(r)),
    limit,
    hint: 'narrow with kind/target/severity/triage filters',
  });
}

async function get(ctx: McpContext, input: Input) {
  if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for get');
  const row = await readReport(input.reportId);
  if (!row) throw new Error('NOT_FOUND: agent report not found');
  // No caller-supplied project here — membership is checked against the
  // row's own project, resolved only after the row is known.
  await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(row.projectId));
  const [view] = await reportViews([row]);
  return { report: view ? frameReport(view) : null };
}

const ACTIONS = { submit, list, get, triage } as const;

async function handleAgentReport(ctx: McpContext, args: unknown) {
  const input = inputSchema.parse(args);
  return ACTIONS[input.action](ctx, input);
}

function triageOf(input: Input): TriageAgentReportRequest {
  const parsed = triageAgentReportRequestSchema.safeParse({
    act: input.act,
    ...(input.issue !== undefined ? { issue: input.issue } : {}),
    ...(input.createIssue !== undefined ? { createIssue: input.createIssue } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.duplicateOf !== undefined ? { duplicateOf: input.duplicateOf } : {}),
  });
  if (!parsed.success) {
    throw new Error(
      `BAD_REQUEST: triage needs ${TRIAGE_AGENT_REPORT_SHAPE}; ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

async function triage(ctx: McpContext, input: Input) {
  const { principal } = ctx;
  const act = triageOf(input);
  const actor = { userId: principal.userId, agency: principalAgency(principal) };
  let visibleOnce: Promise<string[]> | null = null;
  const visible = () => {
    visibleOnce ??= loadVisibleProjectIdsForPrincipal(principal);
    return visibleOnce;
  };
  let linkIssue: { id: string; key: string } | null = null;
  if (act.act === 'file' && act.issue) {
    linkIssue = await visibleIssue(act.issue, await visible());
    if (!linkIssue)
      throw new Error(`NOT_FOUND: issue ${act.issue} not found in any project you can see`);
  }
  let scope: SQL[];
  if (input.signalKey) {
    if (input.scope === 'all') {
      if (act.act === 'file' && act.createIssue) {
        throw new Error(
          'BAD_REQUEST: createIssue files into one project, so a scope="all" triage names an existing issue instead',
        );
      }
      const writable = writableProjectIds(await visibleProjectsWithRole(principal));
      if (writable.length === 0) {
        throw new Error('NOT_FOUND: no project you can write to holds agent reports');
      }
      scope = [
        inArray(agentReports.projectId, writable),
        eq(agentReports.signalKey, input.signalKey),
      ];
    } else {
      const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
      await requireCan(actorFor(principal.userId), 'project.read', projectResource(projectId));
      scope = [eq(agentReports.projectId, projectId), eq(agentReports.signalKey, input.signalKey)];
    }
  } else {
    if (input.scope === 'all') {
      throw new Error('BAD_REQUEST: scope="all" requires signalKey for a bulk triage');
    }
    if (!input.reportId) throw new Error('BAD_REQUEST: triage needs reportId or signalKey');
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await requireCan(actorFor(principal.userId), 'project.read', projectResource(projectId));
    const row = await readReport(input.reportId);
    if (!row || row.projectId !== projectId) {
      throw new Error(`NOT_FOUND: agent report ${input.reportId} not found in this project`);
    }
    scope = [eq(agentReports.id, input.reportId)];
  }
  const out = await triageReports({
    scope,
    bulk: Boolean(input.signalKey),
    act,
    actor,
    channel: 'mcp',
    linkIssue,
  });
  if (!out.ok) return refusedAnswer(out.refusals, 'AGENT_REPORT_REFUSED');
  return { effect: out.effect };
}

async function visibleProjectsWithRole(
  principal: McpContext['principal'],
): Promise<VisibleProjectWithRole[]> {
  const rows = await listVisibleProjectsWithRole(principal.userId);
  const allow = patEffectiveProjectIds(principal);
  if (allow === null) return rows;
  const allowSet = new Set(allow);
  return rows.filter((r) => allowSet.has(r.id));
}

export const forgeAgentReportTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_agent_report',
  reach: 'project',
  route: '/api/agent-reports',
  grant: GRANT,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => handleAgentReport(ctx, args),
});
