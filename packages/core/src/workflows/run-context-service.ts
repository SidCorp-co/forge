import { sql } from 'drizzle-orm';
import { mergeSessionMetadata } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import type { DesignStatus } from './design.js';
import type { LoadedPinnedContract } from './pinned-contracts.js';
import {
  type LoadedRequirement,
  type MockupContextRow,
  type RequirementContextRow,
  requirementContext,
} from './requirement-context.js';
import {
  ARTIFACT_CONTEXT_KEY,
  artifactContext,
  artifactContextRecord,
  artifactContextRefusal,
  type LoadedArtifact,
  type TracedDesignRow,
} from './run-context.js';

const designRowOf = (r: Record<string, unknown>): TracedDesignRow => ({
  workflowId: String(r.id),
  flow: String(r.flow),
  designStatus: (r.design_status as DesignStatus | null) ?? null,
  workflowRevision: Number(r.revision),
  approvedRevision: r.given_revision == null ? null : Number(r.given_revision),
  revisionRow: r.has_row
    ? { document: r.document, decision: (r.decision as string | null) ?? null }
    : null,
});

/**
 * The designs a job on `issueId` is given. An issue that delivers a requirement is given every
 * design revision the requirement's latest baseline pins (REQ-1 BC-7, REQ-4 BC-12), and a workflow
 * it builds that the baseline does not pin is refused by name; any other issue is given the
 * approved revision of the workflow it builds (REQ-1 BC-1).
 */
export async function tracedDesignsOf(issueId: string): Promise<TracedDesignRow[]> {
  const [issue] = (await db.execute(sql`
    SELECT i.requirement_id, r.req_seq, w.id AS built_id, w.flow AS built_flow
    FROM issues i
    LEFT JOIN requirements r ON r.id = i.requirement_id
    LEFT JOIN workflow_builds wb ON wb.issue_id = i.id
    LEFT JOIN project_workflows w ON w.id = wb.workflow_id
    WHERE i.id = ${issueId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (issue?.requirement_id) return pinnedDesignsOf(issue);
  const rows = (await db.execute(sql`
    SELECT w.id, w.flow, w.design_status, w.revision, w.approved_revision AS given_revision,
           d.workflow_id IS NOT NULL AS has_row, d.document, d.decision
    FROM workflow_builds wb
    JOIN project_workflows w ON w.id = wb.workflow_id
    LEFT JOIN project_workflow_designs d
      ON d.workflow_id = w.id AND d.revision = w.approved_revision
    WHERE wb.issue_id = ${issueId}
    ORDER BY w.flow
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(designRowOf);
}

async function pinnedDesignsOf(issue: Record<string, unknown>): Promise<TracedDesignRow[]> {
  const requirementId = String(issue.requirement_id);
  const key = `REQ-${Number(issue.req_seq)}`;
  const rows = (await db.execute(sql`
    SELECT w.id, w.flow, w.design_status, w.revision, w.approved_revision,
           p.design_revision AS given_revision,
           d.workflow_id IS NOT NULL AS has_row, d.document, d.decision
    FROM requirement_baseline_pins p
    JOIN project_workflows w ON w.id = p.workflow_id
    LEFT JOIN project_workflow_designs d
      ON d.workflow_id = p.workflow_id AND d.revision = p.design_revision
    WHERE p.requirement_id = ${requirementId}
      AND (p.revision, p.baseline_seq) = (
        SELECT revision, seq FROM requirement_baselines WHERE requirement_id = ${requirementId}
         ORDER BY revision DESC, seq DESC LIMIT 1)
    ORDER BY w.flow
  `)) as unknown as Array<Record<string, unknown>>;
  if (issue.built_id && !rows.some((r) => String(r.id) === String(issue.built_id))) {
    throw artifactContextRefusal(
      'ARTIFACT_CONTEXT_UNLOADABLE',
      {
        kind: 'workflow-design',
        ref: String(issue.built_flow),
        workflowId: String(issue.built_id),
        revision: null,
      },
      `the issue builds it, and ${key}'s latest baseline pins no revision of it; link the design to ${key} and re-pin, or unlink the build`,
    );
  }
  return rows.map((r) => ({
    ...designRowOf(r),
    pinnedBy: {
      key,
      currentApproved: r.approved_revision == null ? null : Number(r.approved_revision),
    },
  }));
}

/** The designs a build job on `issueId` is given; empty when there are none. */
export async function loadArtifactContext(issueId: string): Promise<LoadedArtifact[]> {
  return artifactContext(await tracedDesignsOf(issueId));
}

const mockupLineOf = (m: Record<string, unknown>): MockupContextRow => ({
  key: `MK-${Number(m.mockup_seq)}`,
  kind: String(m.mockup_kind),
  name: String(m.mockup_name),
  caption: m.mockup_caption == null ? null : String(m.mockup_caption),
});

/** The mockups accepted on `issueId` itself, which its job is given beside its requirement's. */
export async function issueMockupsOf(issueId: string): Promise<MockupContextRow[]> {
  const rows = (await db.execute(sql`
    SELECT mockup_seq, kind AS mockup_kind, name AS mockup_name, caption AS mockup_caption
    FROM mockups WHERE issue_id = ${issueId} AND status = 'accepted'
    ORDER BY mockup_seq
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(mockupLineOf);
}

/** The requirement `issueId` delivers, at its head, with the criteria of that revision and its latest baseline. */
export async function requirementRowOf(issueId: string): Promise<RequirementContextRow | null> {
  const [r] = (await db.execute(sql`
    SELECT r.id, r.req_seq, r.title, r.status, r.current_revision, i.planned_revision,
           i.planned_baseline_seq, i.plan,
           rv.state AS head_state, rv.tldr, rv.spec->>'goal' AS goal
    FROM issues i
    JOIN requirements r ON r.id = i.requirement_id
    LEFT JOIN requirement_revisions rv
      ON rv.requirement_id = r.id AND rv.revision = r.current_revision
    WHERE i.id = ${issueId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!r) return null;
  const id = String(r.id);
  const current = r.current_revision == null ? null : Number(r.current_revision);
  const [criteria, baselines] = await Promise.all([
    current === null
      ? Promise.resolve([] as Array<Record<string, unknown>>)
      : (db.execute(sql`
          SELECT id, code, body, form FROM requirement_criteria
          WHERE requirement_id = ${id} AND since_revision <= ${current}
            AND (retired_revision IS NULL OR retired_revision > ${current})
          ORDER BY substring(code from 4)::int
        `) as unknown as Promise<Array<Record<string, unknown>>>),
    db.execute(sql`
      SELECT b.revision, b.seq, b.agreed_at, p.workflow_id, w.flow, p.design_revision,
             p.provider_project_id, p.contract_slug, p.contract_version,
             m.mockup_seq, m.kind AS mockup_kind, m.name AS mockup_name, m.caption AS mockup_caption
      FROM requirement_baselines b
      LEFT JOIN requirement_baseline_pins p
        ON p.requirement_id = b.requirement_id AND p.revision = b.revision AND p.baseline_seq = b.seq
      LEFT JOIN project_workflows w ON w.id = p.workflow_id
      LEFT JOIN mockups m ON m.id = p.mockup_id
      WHERE b.requirement_id = ${id}
        AND (b.revision, b.seq) = (
          SELECT revision, seq FROM requirement_baselines WHERE requirement_id = ${id}
           ORDER BY revision DESC, seq DESC LIMIT 1)
      ORDER BY w.flow NULLS LAST, p.contract_slug, m.mockup_seq
    `) as unknown as Promise<Array<Record<string, unknown>>>,
  ]);
  const first = baselines[0];
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    requirementId: id,
    key: `REQ-${Number(r.req_seq)}`,
    title: String(r.title),
    status: String(r.status),
    currentRevision: current,
    headState: str(r.head_state),
    tldr: str(r.tldr),
    goal: str(r.goal),
    criteria: criteria.map((c) => ({
      id: String(c.id),
      code: String(c.code),
      body: String(c.body),
      form: String(c.form),
    })),
    baseline: first
      ? {
          revision: Number(first.revision),
          seq: Number(first.seq),
          agreedAt: new Date(String(first.agreed_at)).toISOString(),
          pins: baselines
            .filter((p) => p.workflow_id != null || p.contract_slug != null)
            .map((p) => ({
              workflowId: str(p.workflow_id),
              flow: str(p.flow),
              designRevision: p.design_revision == null ? null : Number(p.design_revision),
              contractSlug: str(p.contract_slug),
              contractVersion: str(p.contract_version),
              providerProjectId: str(p.provider_project_id),
            })),
          mockups: baselines.filter((p) => p.mockup_seq != null).map(mockupLineOf),
        }
      : null,
    plannedRevision: r.planned_revision == null ? null : Number(r.planned_revision),
    plannedBaselineSeq: r.planned_baseline_seq == null ? null : Number(r.planned_baseline_seq),
    plan: str(r.plan),
  };
}

/** The requirement a job on `issueId` is given; null when the issue delivers none. */
export async function loadRequirementContext(
  issueId: string,
  mockupsWithheld = false,
): Promise<LoadedRequirement | null> {
  return requirementContext(await requirementRowOf(issueId), mockupsWithheld);
}

/** Stamps the load on the job's session metadata, merged so no other key is touched. */
export async function recordArtifactContext(
  agentSessionId: string,
  loaded: readonly LoadedArtifact[],
  source: string,
  requirement: LoadedRequirement | null = null,
  contracts: readonly LoadedPinnedContract[] = [],
): Promise<void> {
  await mergeSessionMetadata(agentSessionId, {
    [ARTIFACT_CONTEXT_KEY]: artifactContextRecord(loaded, source, requirement, contracts),
  });
}
