import { and, count, desc, eq } from 'drizzle-orm';
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
} from '../../db/schema.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const MAX_RESPONSE_CHARS = 38_000;

const inputSchema = z
  .object({
    action: z.enum(['submit', 'list']),
    projectId: z.uuid().optional(),
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
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

function buildSignalKey(target: string, targetRef: string | null | undefined, kind: string): string {
  return `self_report:${target}:${targetRef ?? '-'}:${kind}`;
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

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  description:
    'Submit or list agent friction reports. ' +
    'action=submit: report friction, skill gaps, unclear steps, or learnings mid-run. ' +
    'Pipeline context (issueId/runId/jobId/stage) is resolved server-side from your active job — do NOT supply it. ' +
    'Required fields: kind, target, summary. Optional: severity (default low), targetRef, detail, suggestion. ' +
    'Returns {ok:true,id,signalKey} on success; {ok:false,reason:"rate_limited"} when the per-job cap is hit (not a 500 — agent continues). ' +
    'action=list: read the friction feed for a project. Supports filters.kind/target/severity, limit (default 25). ' +
    'Large histories are tail-trimmed with truncated:true. Requires project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal, device } = ctx;

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

        if (principal.kind === 'device') {
          const ctx_ = await resolveActiveJobContext(device.id);
          if (ctx_) {
            jobId = ctx_.jobId;
            runId = ctx_.runId;
            issueId = ctx_.issueId ?? null;
            stage = ctx_.stage ?? null;
          }
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
    }
  },
});
