import { eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  countReportsForJob,
  insertReport,
  issueVisibleIn,
  listReports,
  readReport,
  reportViews,
  stampReviewed,
} from '../../agent-reports/service.js';
import { env } from '../../config/env.js';
import {
  agentReportKinds,
  agentReportSeverities,
  agentReports,
  agentReportTargets,
} from '../../db/schema.js';
import { resolvePipelineContext } from '../../jobs/active-job-context.js';
import { markUntrusted, sanitizeUntrusted, stripFrameTokens } from '../../prompt/sanitize.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  type McpContext,
  refusedAnswer,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

const inputSchema = z
  .object({
    action: z.enum(['submit', 'list', 'review', 'get']),
    projectId: z.uuid().optional(),
    scope: z.enum(['project', 'all']).optional(),
    reportId: z.uuid().optional(),
    reviewed: z.boolean().optional(),
    linkedIssueId: z.uuid().optional(),
    // bulk-review field: stamp every report sharing this signalKey
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
        reviewed: z.boolean().optional(),
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
  'Submit, list, get, or review agent friction reports. ' +
  'action=submit: report friction, skill gaps, unclear steps, or learnings mid-run. ' +
  'Pipeline context (issueId/runId/jobId/stage) is resolved server-side from your active job — do NOT supply it. ' +
  'Required fields: projectId, kind, target, summary. ' +
  'projectId names the project the report is ABOUT, which need not be the one you are working in; it is REQUIRED and never inferred, because a report filed into the wrong feed is never read (`forge_projects.list` prints it beside each slug — it is its own tool, not an action on one). ' +
  'Optional: severity (default low), targetRef, detail, suggestion. ' +
  'Returns {ok:true,id,signalKey} on success; {ok:false,reason:"rate_limited"} when the per-job cap is hit (not a 500 — agent continues). ' +
  'action=list: read the friction feed. Supports filters.kind/target/severity/reviewed, limit (default 25, fleet default 50). ' +
  'scope="project" (default) reads the resolved project; scope="all" unions every project you own or are a member of and adds projectId/projectSlug to each row. ' +
  'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete. `truncated:true` + `truncatedBy` say which cap bit (your limit, or the hard response-size cap). ' +
  'action=get: fetch one report by reportId, resolving its project from the row itself — no projectId needed. NOT_FOUND if missing or not visible to you. ' +
  'A report promoted into product feedback carries `feedback` { key, phase, route } and stays reviewed: reviewed:false or a linkedIssueId on it is AGENT_REPORT_PROMOTED (promote with forge_feedback_items action=promote). ' +
  'action=review: stamp reviewedAt on report(s) once triaged/addressed (reviewed:false clears the stamp). ' +
  'reportId stamps a single report (unchanged single-project behaviour). ' +
  'When folding a report into an issue, also pass linkedIssueId (must belong to the same project as the report, or NOT_FOUND) — it is stamped atomically with reviewedAt and returned, so the report becomes traceable to what it became. ' +
  'Omitting linkedIssueId on a later review call leaves any existing link untouched (back-compat); reviewed:false clears BOTH reviewedAt and linkedIssueId. ' +
  'Curators (e.g. forge-memory-curator, or anyone triaging reports into an issue) SHOULD pass linkedIssueId so the loop closes. ' +
  'signalKey bulk-stamps every report sharing that signalKey — add scope="all" to bulk-stamp across every project you can see (scope="all" without signalKey is a BAD_REQUEST); returns {ok:true,count,scope,linkedIssueId}. linkedIssueId IS supported on the bulk path: N duplicate reports of one Forge defect fold into ONE issue in a single call. A report is ABOUT FORGE — its projectId records where the defect was OBSERVED, not who owns the fix — so linkedIssueId may name an issue in ANY project you can see (normally the Forge project), not just the one the report was filed from. reviewed:false clears reviewedAt AND linkedIssueId.';

// The grant strings keep the `feedback` resource name issued tokens store (auth/pat-permissions.ts).
const GRANT = {
  byAction: {
    submit: 'feedback:write',
    list: 'feedback:read',
    review: 'feedback:write',
    get: 'feedback:read',
  },
} as const;

async function handleAgentReport(ctx: McpContext, args: unknown) {
  const input = inputSchema.parse(args);
  const { principal } = ctx;

  switch (input.action) {
    case 'submit': {
      if (!input.projectId) {
        throw new Error(
          'BAD_REQUEST: projectId is required for submit — a report is filed against the project whose defect it describes, and the server will not guess which that is. ' +
            'Pass the projectId of the project this report is ABOUT (not necessarily the one you are working in); `forge_projects.list` prints it beside each slug.',
        );
      }
      const projectId = input.projectId;
      await assertPrincipalIsMember(principal, projectId);

      if (!input.kind) throw new Error('BAD_REQUEST: kind is required for submit');
      if (!input.target) throw new Error('BAD_REQUEST: target is required for submit');
      if (!input.summary) throw new Error('BAD_REQUEST: summary is required for submit');

      const resolved = await resolvePipelineContext(principal);
      const active = resolved.ok ? resolved.context : null;
      const jobId = active?.jobId ?? null;
      const runId = active?.runId ?? null;
      const issueId = active?.issueId ?? null;
      const stage = active?.stage ?? null;
      const sessionId = active?.agentSessionId ?? null;

      // Per-job rate-limit (server-enforced). Interactive callers (no jobId)
      // have no pipeline run to cap by; skip the check.
      if (jobId) {
        const limit = env.FEEDBACK_MAX_PER_JOB;
        const existing = await countReportsForJob(jobId);
        if (existing >= limit) {
          return { ok: false, reason: 'rate_limited', limit };
        }
      }

      const signalKey = buildSignalKey(input.target, input.targetRef, input.kind);

      const insertedId = await insertReport({
        projectId,
        issueId: issueId ?? undefined,
        runId: runId ?? undefined,
        jobId: jobId ?? undefined,
        stage: stage ?? undefined,
        kind: input.kind,
        severity: input.severity ?? 'low',
        target: input.target,
        targetRef: input.targetRef ?? undefined,
        summary: input.summary,
        detail: input.detail ?? undefined,
        suggestion: input.suggestion ?? undefined,
        signalKey,
        sessionId: sessionId ?? undefined,
      });

      if (!insertedId) throw new Error('forge_agent_report: insert returned no row');
      return { ok: true, id: insertedId, signalKey };
    }

    case 'list': {
      const filters = input.filters ?? {};
      const kindCondition = filters.kind ? eq(agentReports.kind, filters.kind) : undefined;
      const targetCondition = filters.target ? eq(agentReports.target, filters.target) : undefined;
      const severityCondition = filters.severity
        ? eq(agentReports.severity, filters.severity)
        : undefined;
      const reviewedCondition =
        filters.reviewed === true
          ? isNotNull(agentReports.reviewedAt)
          : filters.reviewed === false
            ? isNull(agentReports.reviewedAt)
            : undefined;

      let scopeCondition: ReturnType<typeof eq> | ReturnType<typeof inArray>;
      let limit: number;
      if (input.scope === 'all') {
        const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
        if (visibleIds.length === 0)
          return { reports: [], returned: 0, limit: input.limit ?? 50, hasMore: false };
        scopeCondition = inArray(agentReports.projectId, visibleIds);
        limit = input.limit ?? 50;
      } else {
        const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
        await assertPrincipalIsMember(principal, projectId);
        scopeCondition = eq(agentReports.projectId, projectId);
        limit = input.limit ?? 25;
      }

      const rows = await listReports(
        [scopeCondition, kindCondition, targetCondition, severityCondition, reviewedCondition],
        overfetch(limit),
      );

      return buildListEnvelope({
        key: 'reports',
        items: (await reportViews(rows)).map((r) => frameReport(r)),
        limit,
        hint: 'narrow with kind/target/severity/reviewed filters',
      });
    }

    case 'get': {
      if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for get');

      const row = await readReport(input.reportId);
      if (!row) throw new Error('NOT_FOUND: agent report not found');

      // No caller-supplied project here — membership is checked against the
      // row's own project, resolved only after the row is known.
      await assertPrincipalIsMember(principal, row.projectId);

      const [view] = await reportViews([row]);
      return { report: view ? frameReport(view) : null };
    }

    case 'review': {
      const reviewed = input.reviewed ?? true;

      let visibleIdsOnce: Promise<string[]> | null = null;
      const visibleIds = (): Promise<string[]> => {
        visibleIdsOnce ??= loadVisibleProjectIdsForPrincipal(principal);
        return visibleIdsOnce;
      };

      const resolveLinkedIssue = async (linkedIssueId: string): Promise<string> => {
        const ids = await visibleIds();
        if (ids.length === 0) {
          throw new Error('NOT_FOUND: linkedIssueId not found in any project you can see');
        }
        if (!(await issueVisibleIn(linkedIssueId, ids))) {
          throw new Error('NOT_FOUND: linkedIssueId not found in any project you can see');
        }
        return linkedIssueId;
      };
      const linkPatch = async (): Promise<{ linkedIssueId?: string | null }> => {
        if (!reviewed) return { linkedIssueId: null };
        if (!input.linkedIssueId) return {};
        return { linkedIssueId: await resolveLinkedIssue(input.linkedIssueId) };
      };

      if (input.signalKey) {
        // Bulk stamp: every report carrying this signalKey, within scope.
        if (input.scope === 'all') {
          const ids = await visibleIds();
          if (ids.length === 0) {
            return { ok: true, count: 0, scope: 'all', linkedIssueId: null };
          }
          const out = await stampReviewed(
            [inArray(agentReports.projectId, ids), eq(agentReports.signalKey, input.signalKey)],
            { reviewed, ...(await linkPatch()) },
          );
          if (!out.ok) return refusedAnswer(out.refusals, 'AGENT_REPORT_REFUSED');
          return {
            ok: true,
            count: out.rows.length,
            scope: 'all',
            linkedIssueId: reviewed ? (input.linkedIssueId ?? null) : null,
          };
        }

        const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
        await assertPrincipalIsMember(principal, projectId);
        const out = await stampReviewed(
          [eq(agentReports.projectId, projectId), eq(agentReports.signalKey, input.signalKey)],
          { reviewed, ...(await linkPatch()) },
        );
        if (!out.ok) return refusedAnswer(out.refusals, 'AGENT_REPORT_REFUSED');
        return {
          ok: true,
          count: out.rows.length,
          scope: 'project',
          linkedIssueId: reviewed ? (input.linkedIssueId ?? null) : null,
        };
      }

      if (input.scope === 'all') {
        throw new Error('BAD_REQUEST: scope="all" requires signalKey for a bulk review');
      }

      // Single-report path — scope the update to the resolved project so a
      // member of project A can never stamp a report belonging to project
      // B by guessing its id.
      const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
      await assertPrincipalIsMember(principal, projectId);
      if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for review');

      const patch = await linkPatch();

      const out = await stampReviewed(
        [eq(agentReports.id, input.reportId), eq(agentReports.projectId, projectId)],
        { reviewed, ...patch },
      );
      if (!out.ok) return refusedAnswer(out.refusals, 'AGENT_REPORT_REFUSED');
      const [updated] = out.rows;

      if (!updated) throw new Error('NOT_FOUND: agent report not found in this project');
      return {
        ok: true,
        id: updated.id,
        reviewedAt: updated.reviewedAt?.toISOString() ?? null,
        linkedIssueId: updated.linkedIssueId ?? null,
      };
    }
  }
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

/** What every `forge_feedback` result carries, so a caller of the old name is told the new one. */
export const FORGE_FEEDBACK_DEPRECATION = {
  tool: 'forge_feedback',
  replacement: 'forge_agent_report',
  reason:
    'agent friction reports are `agent_reports` now; the word `feedback` belongs to a person reporting on the product',
  endsWhen: 'forge-plugin no longer calls forge_feedback',
} as const;

// cm:hack the pinned forge-plugin's `forge feedback` verb still calls `forge_feedback`, so the old
// name runs the same handler and says it is deprecated — ends when forge-plugin moves to
// `forge_agent_report` (logged in forge-local-docs/plugin-followups.md); then delete this tool.
export const forgeFeedbackAliasTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  reach: 'project',
  route: '/api/agent-reports',
  grant: GRANT,
  description: `[DEPRECATED alias — use forge_agent_report; every result carries a \`deprecation\` field] ${DESCRIPTION}`,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    if (ctx.deprecations) ctx.deprecations.add('forge_feedback');
    const result = await handleAgentReport(ctx, args);
    return { ...result, deprecation: FORGE_FEEDBACK_DEPRECATION };
  },
});
