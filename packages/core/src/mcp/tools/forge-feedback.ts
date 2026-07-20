import { and, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  agentSessions,
  feedbackKinds,
  feedbackReports,
  feedbackSeverities,
  feedbackTargets,
  jobs,
  projects,
} from '../../db/schema.js';
import { markUntrusted, sanitizeUntrusted, stripFrameTokens } from '../../prompt/sanitize.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  loadVisibleProjectIdsForPrincipal,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const MAX_RESPONSE_CHARS = 38_000;

const inputSchema = z
  .object({
    action: z.enum(['submit', 'list', 'review']),
    projectId: z.uuid().optional(),
    // list fleet rollup — action=list only; ignored otherwise. Default 'project'.
    scope: z.enum(['project', 'all']).optional(),
    // review fields
    reportId: z.uuid().optional(),
    reviewed: z.boolean().optional(),
    // submit fields
    kind: z.enum(feedbackKinds).optional(),
    severity: z.enum(feedbackSeverities).optional(),
    target: z.enum(feedbackTargets).optional(),
    targetRef: z.string().max(500).optional(),
    summary: z.string().min(1).max(2000).optional(),
    detail: z.string().max(5000).optional(),
    suggestion: z.string().max(2000).optional(),
    // list filters
    filters: z
      .object({
        kind: z.enum(feedbackKinds).optional(),
        target: z.enum(feedbackTargets).optional(),
        severity: z.enum(feedbackSeverities).optional(),
        reviewed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

function buildSignalKey(
  target: string,
  targetRef: string | null | undefined,
  kind: string,
): string {
  const safeRef = targetRef ? stripFrameTokens(sanitizeUntrusted(targetRef)) : '-';
  return `self_report:${target}:${safeRef}:${kind}`;
}

type ActiveJobContext = {
  jobId: string;
  runId: string;
  issueId: string | null;
  stage: string | null;
};

async function resolveActiveJobContext(deviceId: string): Promise<ActiveJobContext | null> {
  // Find the running agent session for this device, then join to its job.
  const [row] = await db
    .select({
      jobId: jobs.id,
      runId: jobs.pipelineRunId,
      issueId: jobs.issueId,
      stage: jobs.type,
    })
    .from(agentSessions)
    .innerJoin(jobs, eq(jobs.agentSessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.deviceId, deviceId),
        eq(agentSessions.status, 'running'),
        eq(jobs.status, 'running'),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ISS-557 — steward runs are schedule sessions with no job row, so the job-join
// above resolves null. This session-level lookup covers both pipeline + schedule sessions.
async function resolveActiveSessionId(deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.deviceId, deviceId), eq(agentSessions.status, 'running')))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

/** Tail-trim oldest rows so the serialized `{reports}` payload stays under the MCP output cap. */
function trimFeedbackResponse(serialized: Array<Record<string, unknown>>): Record<string, unknown> {
  let kept = serialized;
  let truncated = false;
  const totalCount = kept.length;
  while (kept.length > 1 && JSON.stringify({ reports: kept }).length > MAX_RESPONSE_CHARS) {
    kept = kept.slice(0, kept.length - 1);
    truncated = true;
  }

  const result: Record<string, unknown> = { reports: kept };
  if (truncated) {
    result.truncated = true;
    result.notice = `Response truncated to the ${kept.length} most recent of ${totalCount} reports to stay under the MCP output cap. Narrow with kind/target/severity filters or a smaller limit.`;
  }
  return result;
}

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  description:
    'Submit or list agent friction reports. ' +
    'action=submit: report friction, skill gaps, unclear steps, or learnings mid-run. ' +
    'Pipeline context (issueId/runId/jobId/stage) is resolved server-side from your active job — do NOT supply it. ' +
    'Required fields: kind, target, summary. Optional: severity (default low), targetRef, detail, suggestion. ' +
    'Returns {ok:true,id,signalKey} on success; {ok:false,reason:"rate_limited"} when the per-job cap is hit (not a 500 — agent continues). ' +
    'action=list: read the friction feed for a project. Supports filters.kind/target/severity/reviewed, limit (default 25). ' +
    'scope="project" (default) reads one project (projectId arg > X-Forge-Project-Slug header). ' +
    'scope="all" rolls up the feed across every project you can see (owned or member) — each row carries ' +
    'projectId/projectSlug; results are bounded to your visible projects, never a bespoke admin-wide view. ' +
    'Large histories are tail-trimmed with truncated:true. Requires project membership. ' +
    'action=review: stamp reviewedAt on a report once it has been triaged/addressed (reportId required; reviewed:false clears the stamp). Requires project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal, device } = ctx;

    // Fleet rollup — bounded to the caller's own visible projects (owns or
    // member), same primitive as forge_ops_health/forge_metrics. No single
    // effective project to resolve/assert membership on here.
    if (input.action === 'list' && input.scope === 'all') {
      const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
      if (visibleIds.length === 0) return { reports: [] };

      const filters = input.filters ?? {};
      const conditions = [inArray(feedbackReports.projectId, visibleIds)];
      if (filters.kind) conditions.push(eq(feedbackReports.kind, filters.kind));
      if (filters.target) conditions.push(eq(feedbackReports.target, filters.target));
      if (filters.severity) conditions.push(eq(feedbackReports.severity, filters.severity));
      if (filters.reviewed === true) conditions.push(isNotNull(feedbackReports.reviewedAt));
      if (filters.reviewed === false) conditions.push(isNull(feedbackReports.reviewedAt));

      const rows = await db
        .select({
          id: feedbackReports.id,
          projectId: feedbackReports.projectId,
          projectSlug: projects.slug,
          issueId: feedbackReports.issueId,
          runId: feedbackReports.runId,
          jobId: feedbackReports.jobId,
          stage: feedbackReports.stage,
          kind: feedbackReports.kind,
          severity: feedbackReports.severity,
          target: feedbackReports.target,
          targetRef: feedbackReports.targetRef,
          summary: feedbackReports.summary,
          detail: feedbackReports.detail,
          suggestion: feedbackReports.suggestion,
          signalKey: feedbackReports.signalKey,
          sessionId: feedbackReports.sessionId,
          reviewedAt: feedbackReports.reviewedAt,
          createdAt: feedbackReports.createdAt,
        })
        .from(feedbackReports)
        .leftJoin(projects, eq(projects.id, feedbackReports.projectId))
        .where(and(...conditions))
        .orderBy(desc(feedbackReports.createdAt))
        .limit(input.limit ?? 25);

      const serialized = rows.map((r) => ({
        ...r,
        // Untrusted: agent-submitted text must be framed as DATA, not instructions.
        summary: markUntrusted(r.summary, { source: 'feedback.summary' }),
        detail: r.detail ? markUntrusted(r.detail, { source: 'feedback.detail' }) : null,
        suggestion: r.suggestion
          ? markUntrusted(r.suggestion, { source: 'feedback.suggestion' })
          : null,
        targetRef: r.targetRef
          ? markUntrusted(r.targetRef, { source: 'feedback.targetRef' })
          : null,
      }));

      return trimFeedbackResponse(serialized);
    }

    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsMember(principal, projectId);

    switch (input.action) {
      case 'submit': {
        if (!input.kind) throw new Error('BAD_REQUEST: kind is required for submit');
        if (!input.target) throw new Error('BAD_REQUEST: target is required for submit');
        if (!input.summary) throw new Error('BAD_REQUEST: summary is required for submit');

        // Server-resolve pipeline context from the active device job.
        // If no active job (interactive/PAT), all context fields stay null.
        let jobId: string | null = null;
        let runId: string | null = null;
        let issueId: string | null = null;
        let stage: string | null = null;

        let sessionId: string | null = null;
        if (principal.kind === 'device') {
          const ctx_ = await resolveActiveJobContext(device.id);
          if (ctx_) {
            jobId = ctx_.jobId;
            runId = ctx_.runId;
            issueId = ctx_.issueId ?? null;
            stage = ctx_.stage ?? null;
          }
          // Resolve session-level link for steward + pipeline sessions (works even with no job).
          sessionId = await resolveActiveSessionId(device.id);
        }

        // Per-job rate-limit (server-enforced). Interactive callers (no jobId)
        // have no pipeline run to cap by; skip the check.
        if (jobId) {
          const limit = env.FEEDBACK_MAX_PER_JOB;
          const [countRow] = await db
            .select({ n: count() })
            .from(feedbackReports)
            .where(eq(feedbackReports.jobId, jobId))
            .limit(1);
          const existing = Number(countRow?.n ?? 0);
          if (existing >= limit) {
            return { ok: false, reason: 'rate_limited', limit };
          }
        }

        const signalKey = buildSignalKey(input.target, input.targetRef, input.kind);

        const [inserted] = await db
          .insert(feedbackReports)
          .values({
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
          })
          .returning({ id: feedbackReports.id, signalKey: feedbackReports.signalKey });

        if (!inserted) throw new Error('forge_feedback: insert returned no row');
        return { ok: true, id: inserted.id, signalKey: inserted.signalKey };
      }

      case 'list': {
        const filters = input.filters ?? {};
        const conditions = [eq(feedbackReports.projectId, projectId)];
        if (filters.kind) conditions.push(eq(feedbackReports.kind, filters.kind));
        if (filters.target) conditions.push(eq(feedbackReports.target, filters.target));
        if (filters.severity) conditions.push(eq(feedbackReports.severity, filters.severity));
        if (filters.reviewed === true) conditions.push(isNotNull(feedbackReports.reviewedAt));
        if (filters.reviewed === false) conditions.push(isNull(feedbackReports.reviewedAt));

        const rows = await db
          .select({
            id: feedbackReports.id,
            issueId: feedbackReports.issueId,
            runId: feedbackReports.runId,
            jobId: feedbackReports.jobId,
            stage: feedbackReports.stage,
            kind: feedbackReports.kind,
            severity: feedbackReports.severity,
            target: feedbackReports.target,
            targetRef: feedbackReports.targetRef,
            summary: feedbackReports.summary,
            detail: feedbackReports.detail,
            suggestion: feedbackReports.suggestion,
            signalKey: feedbackReports.signalKey,
            sessionId: feedbackReports.sessionId,
            reviewedAt: feedbackReports.reviewedAt,
            createdAt: feedbackReports.createdAt,
          })
          .from(feedbackReports)
          .where(and(...conditions))
          .orderBy(desc(feedbackReports.createdAt))
          .limit(input.limit ?? 25);

        const serialized = rows.map((r) => ({
          ...r,
          // Untrusted: agent-submitted text must be framed as DATA, not instructions.
          summary: markUntrusted(r.summary, { source: 'feedback.summary' }),
          detail: r.detail ? markUntrusted(r.detail, { source: 'feedback.detail' }) : null,
          suggestion: r.suggestion
            ? markUntrusted(r.suggestion, { source: 'feedback.suggestion' })
            : null,
          targetRef: r.targetRef
            ? markUntrusted(r.targetRef, { source: 'feedback.targetRef' })
            : null,
        }));

        return trimFeedbackResponse(serialized);
      }

      case 'review': {
        if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for review');
        const reviewed = input.reviewed ?? true;

        // Scope the update to the resolved project so a member of project A
        // can never stamp a report belonging to project B by guessing its id.
        const [updated] = await db
          .update(feedbackReports)
          .set({ reviewedAt: reviewed ? new Date() : null })
          .where(
            and(eq(feedbackReports.id, input.reportId), eq(feedbackReports.projectId, projectId)),
          )
          .returning({ id: feedbackReports.id, reviewedAt: feedbackReports.reviewedAt });

        if (!updated) throw new Error('NOT_FOUND: feedback report not found in this project');
        return {
          ok: true,
          id: updated.id,
          reviewedAt: updated.reviewedAt?.toISOString() ?? null,
        };
      }
    }
  },
});
