import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  agentSessions,
  jobs,
  uxContractRules,
  uxFindingKinds,
  uxFindingStages,
  uxFindings,
  uxRuleSeverities,
} from '../../db/schema.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const MAX_RESPONSE_CHARS = 38_000;
// Defensive cap: one review/verify-live job legitimately emits several findings
// (one per missing state), but a looping agent must not flood the table.
const MAX_FINDINGS_PER_JOB = 50;

const inputSchema = z
  .object({
    action: z.enum(['write', 'list']),
    projectId: z.uuid().optional(),
    // write fields — pipeline context (issueId/runId) is resolved server-side.
    stage: z.enum(uxFindingStages).optional(),
    kind: z.enum(uxFindingKinds).optional(),
    detail: z.string().trim().min(1).max(2000).optional(),
    severity: z.enum(uxRuleSeverities).optional(),
    ruleId: z.uuid().optional(),
    // list filters
    filters: z
      .object({
        issueId: z.uuid().optional(),
        stage: z.enum(uxFindingStages).optional(),
        kind: z.enum(uxFindingKinds).optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

type ActiveJobContext = {
  jobId: string;
  runId: string;
  issueId: string | null;
};

// Resolve the device's running pipeline job → the issue + run the finding
// belongs to. ux_findings.issueId is NOT NULL, so a write with no active
// issue-bound job is rejected (returned as ok:false, not a 500).
async function resolveActiveJobContext(deviceId: string): Promise<ActiveJobContext | null> {
  const [row] = await db
    .select({
      jobId: jobs.id,
      runId: jobs.pipelineRunId,
      issueId: jobs.issueId,
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

export const forgeUxFindingsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ux_findings',
  description:
    'Record or read UX Completeness Contract findings (the learning-loop fuel). ' +
    'action=write: persist a UX gap observed during review or verify-live — a required state/a11y/microcopy/responsive/design-system item the changed UI fails to satisfy. ' +
    'Pipeline context (issueId/runId) is resolved server-side from your active job — do NOT supply it. ' +
    'Required: stage (review|verify-live), kind (missing-state|a11y|microcopy|responsive|design-system|other), detail. Optional: severity (default must), ruleId (the ux-contract rule it violates). ' +
    'Returns {ok:true,id} on success; {ok:false,reason:"no_active_issue"} when no issue-bound job is running; {ok:false,reason:"rate_limited"} past the per-job cap (not a 500 — agent continues). ' +
    'action=list: read findings for a project. Supports filters.issueId/stage/kind, limit (default 25). Requires project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal, device } = ctx;

    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);

    switch (input.action) {
      case 'write': {
        await assertPrincipalIsWriter(principal, projectId);

        if (!input.stage) throw new Error('BAD_REQUEST: stage is required for write');
        if (!input.kind) throw new Error('BAD_REQUEST: kind is required for write');
        if (!input.detail) throw new Error('BAD_REQUEST: detail is required for write');

        // Findings are emitted from inside a running pipeline job; resolve the
        // issue + run from it. Interactive/PAT callers have no active job.
        if (principal.kind !== 'device') {
          return { ok: false, reason: 'no_active_issue' };
        }
        const active = await resolveActiveJobContext(device.id);
        if (!active || !active.issueId) {
          return { ok: false, reason: 'no_active_issue' };
        }

        // Per-job cap, keyed by the run's issue (defensive against loops).
        const [countRow] = await db
          .select({ n: count() })
          .from(uxFindings)
          .where(and(eq(uxFindings.issueId, active.issueId), eq(uxFindings.runId, active.runId)))
          .limit(1);
        if (Number(countRow?.n ?? 0) >= MAX_FINDINGS_PER_JOB) {
          return { ok: false, reason: 'rate_limited', limit: MAX_FINDINGS_PER_JOB };
        }

        // Only accept a ruleId that actually belongs to this project; otherwise
        // drop it to null so a stale/foreign id can't FK-fail the insert.
        let ruleId: string | null = null;
        if (input.ruleId) {
          const [rule] = await db
            .select({ id: uxContractRules.id })
            .from(uxContractRules)
            .where(
              and(eq(uxContractRules.id, input.ruleId), eq(uxContractRules.projectId, projectId)),
            )
            .limit(1);
          ruleId = rule?.id ?? null;
        }

        const [inserted] = await db
          .insert(uxFindings)
          .values({
            projectId,
            issueId: active.issueId,
            runId: active.runId,
            stage: input.stage,
            ruleId: ruleId ?? undefined,
            kind: input.kind,
            detail: input.detail,
            severity: input.severity ?? 'must',
          })
          .returning({ id: uxFindings.id });

        if (!inserted) throw new Error('forge_ux_findings: insert returned no row');
        return { ok: true, id: inserted.id };
      }

      case 'list': {
        await assertPrincipalIsMember(principal, projectId);

        const filters = input.filters ?? {};
        const conditions = [eq(uxFindings.projectId, projectId)];
        if (filters.issueId) conditions.push(eq(uxFindings.issueId, filters.issueId));
        if (filters.stage) conditions.push(eq(uxFindings.stage, filters.stage));
        if (filters.kind) conditions.push(eq(uxFindings.kind, filters.kind));

        const rows = await db
          .select({
            id: uxFindings.id,
            issueId: uxFindings.issueId,
            runId: uxFindings.runId,
            stage: uxFindings.stage,
            ruleId: uxFindings.ruleId,
            kind: uxFindings.kind,
            detail: uxFindings.detail,
            severity: uxFindings.severity,
            createdAt: uxFindings.createdAt,
          })
          .from(uxFindings)
          .where(and(...conditions))
          .orderBy(desc(uxFindings.createdAt))
          .limit(input.limit ?? 25);

        const serialized = rows.map((r) => ({
          ...r,
          // Untrusted: agent-authored finding text must be framed as DATA.
          detail: markUntrusted(r.detail, { source: 'ux-finding.detail' }),
        }));

        let kept = serialized;
        let truncated = false;
        const totalCount = kept.length;
        while (kept.length > 1 && JSON.stringify({ findings: kept }).length > MAX_RESPONSE_CHARS) {
          kept = kept.slice(0, kept.length - 1);
          truncated = true;
        }

        const result: Record<string, unknown> = { findings: kept };
        if (truncated) {
          result.truncated = true;
          result.notice = `Response truncated to the ${kept.length} most recent of ${totalCount} findings to stay under the MCP output cap. Narrow with filters or a smaller limit.`;
        }
        return result;
      }
    }
  },
});
