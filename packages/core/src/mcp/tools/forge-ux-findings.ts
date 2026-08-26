import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  issues,
  uxContractRules,
  uxFindingKinds,
  uxFindingStages,
  uxFindings,
  uxRuleSeverities,
} from '../../db/schema.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import { resolveActiveJobContext } from './active-job-context.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

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
    // cm:guard the escape hatch, for when active-job resolution refused — supplying it ROUTINELY defeats the point: it skips the lookup entirely, so a finding lands with runId:null and no record of which pass found it. Reach for it only after a named refusal.
    issueId: z.uuid().optional(),
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

/**
 * Where a finding is being written, or a refusal that names its own cause.
 *
 * ISS-787: all three refusal paths used to answer the single word
 * `no_active_issue`. Two agents on the same run hit it, could not tell which
 * lookup had missed, pasted their findings into a comment and moved on — so
 * the emit side of the UX loop read as "no findings" when it was "every write
 * was rejected". A reason the caller cannot act on is not a reason.
 */
type FindingTarget =
  | { ok: true; issueId: string; runId: string | null }
  | { ok: false; reason: string; detail: string };

async function resolveTargetFromActiveJob(
  principalKind: string,
  deviceId: string,
): Promise<FindingTarget> {
  if (principalKind !== 'device') {
    return {
      ok: false,
      reason: 'not_pipeline_context',
      detail:
        'Findings resolve their issue from the running pipeline job, and this call did not come from a device principal (interactive session, or a PAT). Pass an explicit `issueId` to write the finding anyway.',
    };
  }
  const active = await resolveActiveJobContext(deviceId);
  if (!active) {
    return {
      ok: false,
      reason: 'no_active_job',
      detail:
        'This device has no dispatched/running job with a live agent session, so there is no pipeline context to attribute the finding to. Pass an explicit `issueId` to write it anyway.',
    };
  }
  if (!active.issueId) {
    return {
      ok: false,
      reason: 'job_not_issue_bound',
      detail: `The active job (stage \`${active.stage}\`) belongs to a run with no issue — pm, interactive and system runs are not issue-bound. Pass an explicit \`issueId\` to say which issue this finding is about.`,
    };
  }
  return { ok: true, issueId: active.issueId, runId: active.runId };
}

async function resolveExplicitTarget(issueId: string, projectId: string): Promise<FindingTarget> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  if (!row) {
    return {
      ok: false,
      reason: 'issue_not_in_project',
      detail: `No issue ${issueId} in this project. A finding is never written against an issue the caller cannot see — check the id, or drop \`issueId\` to resolve it from the active job.`,
    };
  }
  // cm:guard runId stays null here — an explicitly-targeted finding is by definition not attributable to a run, and borrowing the device's current one would credit the wrong pass
  return { ok: true, issueId: row.id, runId: null };
}

export const forgeUxFindingsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ux_findings',
  description:
    'Record or read UX Completeness Contract findings (the learning-loop fuel). ' +
    'action=write: persist a UX gap observed during review or verify-live — a required state/a11y/microcopy/responsive/design-system item the changed UI fails to satisfy. ' +
    'Pipeline context (issueId/runId) is normally resolved server-side from your active job — do NOT supply it. ' +
    'Required: stage (review|verify-live), kind (missing-state|a11y|microcopy|responsive|design-system|other), detail. Optional: severity (default must), ruleId (the ux-contract rule it violates). ' +
    'Returns {ok:true,id} on success. Every refusal carries {ok:false,reason,detail} where `detail` names the remedy: `not_pipeline_context` (not a device principal), `no_active_job` (no dispatched/running job on this device), `job_not_issue_bound` (a pm/interactive/system run), `issue_not_in_project`, or `rate_limited` past the per-job cap. None is a 500 — the agent continues. ' +
    'ESCAPE HATCH: when resolution refuses and you know the issue, pass an explicit `issueId` and the finding is written against it with runId:null. Use it rather than pasting the finding into a comment, which is where findings go to be forgotten. ' +
    'action=list: read findings for a project. Supports filters.issueId/stage/kind, limit (default 25). ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'Requires project membership.',
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

        const target = input.issueId
          ? await resolveExplicitTarget(input.issueId, projectId)
          : await resolveTargetFromActiveJob(principal.kind, device.id);
        if (!target.ok) return target;

        // cm:guard runId is NULL on the explicit-issueId path, and `eq(col, null)` is SQL NULL — never true — so the cap would silently stop capping. Match with isNull, or an agent looping on the escape hatch writes unbounded rows.
        const [countRow] = await db
          .select({ n: count() })
          .from(uxFindings)
          .where(
            and(
              eq(uxFindings.issueId, target.issueId),
              target.runId === null ? isNull(uxFindings.runId) : eq(uxFindings.runId, target.runId),
            ),
          )
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
            issueId: target.issueId,
            runId: target.runId ?? undefined,
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

        const findingsLimit = input.limit ?? 25;
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
          .limit(overfetch(findingsLimit));

        const serialized = rows.map((r) => ({
          ...r,
          // Untrusted: agent-authored finding text must be framed as DATA.
          detail: markUntrusted(r.detail, { source: 'ux-finding.detail' }),
        }));

        return buildListEnvelope({
          key: 'findings',
          items: serialized,
          limit: findingsLimit,
          hint: 'narrow with filters.issueId/stage/kind',
        });
      }
    }
  },
});
