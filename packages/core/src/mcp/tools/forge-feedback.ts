import { eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  feedbackKinds,
  feedbackReports,
  feedbackSeverities,
  feedbackTargets,
} from '../../db/schema.js';
import {
  countReportsForJob,
  insertReport,
  issueVisibleIn,
  listReports,
  readReport,
  resolveActiveSessionId,
  stampReviewed,
} from '../../feedback/service.js';
import { resolveActiveJobContext } from '../../jobs/active-job-context.js';
import { markUntrusted, sanitizeUntrusted, stripFrameTokens } from '../../prompt/sanitize.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

const inputSchema = z
  .object({
    action: z.enum(['submit', 'list', 'review', 'get']),
    projectId: z.uuid().optional(),
    // scope: 'project' (default, caller's resolved project) or 'all' (every
    // project the principal can see) — applies to list and bulk review.
    scope: z.enum(['project', 'all']).optional(),
    // review fields
    reportId: z.uuid().optional(),
    reviewed: z.boolean().optional(),
    // review: the issue this report was curated INTO (distinct from the
    // report's own issueId, which is its source issue). Must belong to the
    // same project as the report.
    linkedIssueId: z.uuid().optional(),
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

function buildSignalKey(
  target: string,
  targetRef: string | null | undefined,
  kind: string,
): string {
  const safeRef = targetRef ? stripFrameTokens(sanitizeUntrusted(targetRef)) : '-';
  return `self_report:${target}:${safeRef}:${kind}`;
}

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  description:
    'Submit, list, get, or review agent friction reports. ' +
    'action=submit: report friction, skill gaps, unclear steps, or learnings mid-run. ' +
    'Pipeline context (issueId/runId/jobId/stage) is resolved server-side from your active job — do NOT supply it. ' +
    'Required fields: kind, target, summary. Optional: severity (default low), targetRef, detail, suggestion. ' +
    'Returns {ok:true,id,signalKey} on success; {ok:false,reason:"rate_limited"} when the per-job cap is hit (not a 500 — agent continues). ' +
    'action=list: read the friction feed. Supports filters.kind/target/severity/reviewed, limit (default 25, fleet default 50). ' +
    'scope="project" (default) reads the resolved project; scope="all" unions every project you own or are a member of and adds projectId/projectSlug to each row. ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete. `truncated:true` + `truncatedBy` say which cap bit (your limit, or the hard response-size cap). ' +
    'action=get: fetch one report by reportId, resolving its project from the row itself — no projectId needed. NOT_FOUND if missing or not visible to you. ' +
    'action=review: stamp reviewedAt on report(s) once triaged/addressed (reviewed:false clears the stamp). ' +
    'reportId stamps a single report (unchanged single-project behaviour). ' +
    'When folding a report into an issue, also pass linkedIssueId (must belong to the same project as the report, or NOT_FOUND) — it is stamped atomically with reviewedAt and returned, so the report becomes traceable to what it became. ' +
    'Omitting linkedIssueId on a later review call leaves any existing link untouched (back-compat); reviewed:false clears BOTH reviewedAt and linkedIssueId. ' +
    'Curators (e.g. forge-memory-curator, or anyone triaging feedback into an issue) SHOULD pass linkedIssueId so the loop closes. ' +
    'signalKey bulk-stamps every report sharing that signalKey — add scope="all" to bulk-stamp across every project you can see (scope="all" without signalKey is a BAD_REQUEST); returns {ok:true,count,scope,linkedIssueId}. linkedIssueId IS supported on the bulk path: N duplicate reports of one Forge defect fold into ONE issue in a single call. A report is feedback ABOUT FORGE — its projectId records where the defect was OBSERVED, not who owns the fix — so linkedIssueId may name an issue in ANY project you can see (normally the Forge project), not just the one the report was filed from. reviewed:false clears reviewedAt AND linkedIssueId.',
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

        if (!insertedId) throw new Error('forge_feedback: insert returned no row');
        return { ok: true, id: insertedId, signalKey };
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
        if (input.scope === 'all') {
          const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
          if (visibleIds.length === 0)
            return { reports: [], returned: 0, limit: input.limit ?? 50, hasMore: false };
          scopeCondition = inArray(feedbackReports.projectId, visibleIds);
          limit = input.limit ?? 50;
        } else {
          const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
          await assertPrincipalIsMember(principal, projectId);
          scopeCondition = eq(feedbackReports.projectId, projectId);
          limit = input.limit ?? 25;
        }

        const rows = await listReports(
          [scopeCondition, kindCondition, targetCondition, severityCondition, reviewedCondition],
          overfetch(limit),
        );

        return buildListEnvelope({
          key: 'reports',
          items: rows.map((r) => frameReport(r)),
          limit,
          hint: 'narrow with kind/target/severity/reviewed filters',
        });
      }

      case 'get': {
        if (!input.reportId) throw new Error('BAD_REQUEST: reportId is required for get');

        const row = await readReport(input.reportId);
        if (!row) throw new Error('NOT_FOUND: feedback report not found');

        // No caller-supplied project here — membership is checked against the
        // row's own project, resolved only after the row is known.
        await assertPrincipalIsMember(principal, row.projectId);

        return { report: frameReport(row) };
      }

      case 'review': {
        const reviewed = input.reviewed ?? true;

        // cm:why a report records WHERE the defect was observed, not who owns the fix — which almost always lands in the Forge project itself, so linkedIssueId resolves against every project the caller can SEE rather than the report's own project; requiring same-project made the field unusable for exactly the reports it exists to close, and caller visibility still bounds the lookup
        const resolveLinkedIssue = async (linkedIssueId: string): Promise<string> => {
          const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
          if (visibleIds.length === 0) {
            throw new Error('NOT_FOUND: linkedIssueId not found in any project you can see');
          }
          if (!(await issueVisibleIn(linkedIssueId, visibleIds))) {
            throw new Error('NOT_FOUND: linkedIssueId not found in any project you can see');
          }
          return linkedIssueId;
        };
        // cm:why bulk and single share this so a signalKey fold and a one-off fold can never drift on what a valid link is
        const linkPatch = async (): Promise<{ linkedIssueId?: string | null }> => {
          if (!reviewed) return { linkedIssueId: null };
          if (!input.linkedIssueId) return {};
          return { linkedIssueId: await resolveLinkedIssue(input.linkedIssueId) };
        };

        if (input.signalKey) {
          // Bulk stamp: every report carrying this signalKey, within scope.
          if (input.scope === 'all') {
            const visibleIds = await loadVisibleProjectIdsForPrincipal(principal);
            if (visibleIds.length === 0) {
              return { ok: true, count: 0, scope: 'all', linkedIssueId: null };
            }
            const updated = await stampReviewed(
              [
                inArray(feedbackReports.projectId, visibleIds),
                eq(feedbackReports.signalKey, input.signalKey),
              ],
              { reviewedAt: reviewed ? new Date() : null, ...(await linkPatch()) },
            );
            return {
              ok: true,
              count: updated.length,
              scope: 'all',
              linkedIssueId: reviewed ? (input.linkedIssueId ?? null) : null,
            };
          }

          const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
          await assertPrincipalIsMember(principal, projectId);
          const updated = await stampReviewed(
            [
              eq(feedbackReports.projectId, projectId),
              eq(feedbackReports.signalKey, input.signalKey),
            ],
            { reviewedAt: reviewed ? new Date() : null, ...(await linkPatch()) },
          );
          return {
            ok: true,
            count: updated.length,
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

        // cm:why ISS-712 — linking is explicit only; nothing here auto-stamps a link by heuristic
        const patch = await linkPatch();

        // cm:why omitting the field leaves an existing link untouched (back-compat); only reviewed:false clears it
        const [updated] = await stampReviewed(
          [eq(feedbackReports.id, input.reportId), eq(feedbackReports.projectId, projectId)],
          { reviewedAt: reviewed ? new Date() : null, ...patch },
        );

        if (!updated) throw new Error('NOT_FOUND: feedback report not found in this project');
        return {
          ok: true,
          id: updated.id,
          reviewedAt: updated.reviewedAt?.toISOString() ?? null,
          linkedIssueId: updated.linkedIssueId ?? null,
        };
      }
    }
  },
});
