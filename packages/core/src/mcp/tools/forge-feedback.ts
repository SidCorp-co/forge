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
    action: z.enum(['submit', 'list', 'review', 'get']),
    projectId: z.uuid().optional(),
    // scope: 'project' (default, caller's resolved project) or 'org' (every
    // project the principal can see) — applies to list and bulk review.
    scope: z.enum(['project', 'org']).optional(),
    // review fields
    reportId: z.uuid().optional(),
    reviewed: z.boolean().optional(),
    // bulk-review field: stamp every report sharing this signalKey
    signalKey: z.string().max(500).optional(),
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
    summary: markUntrusted(r.summary, { source: 'feedback.summary' }),
    detail: r.detail ? markUntrusted(r.detail, { source: 'feedback.detail' }) : null,
    suggestion: r.suggestion
      ? markUntrusted(r.suggestion, { source: 'feedback.suggestion' })
      : null,
    targetRef: r.targetRef ? markUntrusted(r.targetRef, { source: 'feedback.targetRef' }) : null,
  };
}

const reportColumns = {
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
} as const;

function buildSignalKey(target: string, targetRef: string | null | undefined, kind: string): string {
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

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  description:
    'Submit, list, get, or review agent friction reports. ' +
    'action=submit: report friction, skill gaps, unclear steps, or learnings mid-run. ' +
    'Pipeline context (issueId/runId/jobId/stage) is resolved server-side from your active job — do NOT supply it. ' +
    'Required fields: kind, target, summary. Optional: severity (default low), targetRef, detail, suggestion. ' +
    'Returns {ok:true,id,signalKey} on success; {ok:false,reason:"rate_limited"} when the per-job cap is hit (not a 500 — agent continues). ' +
    'action=list: read the friction feed. Supports filters.kind/target/severity/reviewed, limit (default 25, org default 50). ' +
    'scope="project" (default) reads the resolved project; scope="org" unions every project you own or are a member of and adds projectId/projectSlug to each row. ' +
    'Large histories are tail-trimmed with truncated:true. ' +
    'action=get: fetch one report by reportId, resolving its project from the row itself — no projectId needed. NOT_FOUND if missing or not visible to you. ' +
    'action=review: stamp reviewedAt on report(s) once triaged/addressed (reviewed:false clears the stamp). ' +
    'reportId stamps a single report (unchanged single-project behaviour). ' +
    'signalKey bulk-stamps every report sharing that signalKey — add scope="org" to bulk-stamp across every project you can see (scope="org" without signalKey is a BAD_REQUEST); returns {ok:true,count,scope}.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal, device } = ctx;

    switch (input.action) {
      case 'submit': {
        const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
        await assertPrincipalIsMember(principal, projectId);

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
        const kindCondition = filters.kind ? eq(feedbackReports.kind, filters.kind) : undefined;
        const targetCondition = filters.target
          ? eq(feedbackReports.target, filters.target)
          : undefined;
        const severityCondition = filters.severity
          ? eq(feedbackReports.severity, filters.severity)
          : undefined;
        const reviewedCondition =
          filters.reviewed === true
            ? isNotNull(feedbackReports.reviewedAt)
            : filters.reviewed === false
              ? isNull(feedbackReports.reviewedAt)
              : undefined;

        let scopeCondition: ReturnType<typeof eq> | ReturnType<typeof inArray>;
        let limit: number;
        if (input.scope === 'org') {
          const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
          if (visibleIds.length === 0) return { reports: [] };
          scopeCondition = inArray(feedbackReports.projectId, visibleIds);
          limit = input.limit ?? 50;
        } else {
          const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
          await assertPrincipalIsMember(principal, projectId);
          scopeCondition = eq(feedbackReports.projectId, projectId);
          limit = input.limit ?? 25;
        }

        const rows = await db
          .select(reportColumns)
          .from(feedbackReports)
          .leftJoin(projects, eq(projects.id, feedbackReports.projectId))
          .where(and(scopeCondition, kindCondition, targetCondition, severityCondition, reviewedCondition))
          .orderBy(desc(feedbackReports.createdAt))
          .limit(limit);

        const serialized = rows.map((r) => frameReport(r));

        // Tail-trim oldest rows when the serialized response would exceed the cap.
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

      case 'get': {
        if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for get');

        const [row] = await db
          .select(reportColumns)
          .from(feedbackReports)
          .leftJoin(projects, eq(projects.id, feedbackReports.projectId))
          .where(eq(feedbackReports.id, input.reportId))
          .limit(1);

        if (!row) throw new Error('NOT_FOUND: feedback report not found');

        // No caller-supplied project here — membership is checked against the
        // row's own project, resolved only after the row is known.
        await assertPrincipalIsMember(principal, row.projectId);

        return { report: frameReport(row) };
      }

      case 'review': {
        const reviewed = input.reviewed ?? true;

        if (input.signalKey) {
          // Bulk stamp: every report carrying this signalKey, within scope.
          if (input.scope === 'org') {
            const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
            if (visibleIds.length === 0) return { ok: true, count: 0, scope: 'org' };
            const updated = await db
              .update(feedbackReports)
              .set({ reviewedAt: reviewed ? new Date() : null })
              .where(
                and(
                  inArray(feedbackReports.projectId, visibleIds),
                  eq(feedbackReports.signalKey, input.signalKey),
                ),
              )
              .returning({ id: feedbackReports.id });
            return { ok: true, count: updated.length, scope: 'org' };
          }

          const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
          await assertPrincipalIsMember(principal, projectId);
          const updated = await db
            .update(feedbackReports)
            .set({ reviewedAt: reviewed ? new Date() : null })
            .where(
              and(
                eq(feedbackReports.projectId, projectId),
                eq(feedbackReports.signalKey, input.signalKey),
              ),
            )
            .returning({ id: feedbackReports.id });
          return { ok: true, count: updated.length, scope: 'project' };
        }

        if (input.scope === 'org') {
          throw new Error('BAD_REQUEST: scope="org" requires signalKey for a bulk review');
        }

        // Single-report path — unchanged: scope the update to the resolved
        // project so a member of project A can never stamp a report
        // belonging to project B by guessing its id.
        const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
        await assertPrincipalIsMember(principal, projectId);
        if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for review');

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
