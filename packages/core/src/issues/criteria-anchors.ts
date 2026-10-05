// What a verdict is pinned against: the design revisions and contract versions current now, and
// the anchors each issue's verdicts cite.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { contractVersions } from '../db/schema-ecosystem.js';
import { projectWorkflows } from '../db/schema-workflows.js';

/** Each workflow's current revision, under its flow and under its id: the anchor of an issue with no requirement. */
export async function designRevisions(
  projectIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>(projectIds.map((id) => [id, new Map()]));
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      projectId: projectWorkflows.projectId,
      revision: projectWorkflows.revision,
    })
    .from(projectWorkflows)
    .where(inArray(projectWorkflows.projectId, projectIds));
  for (const row of rows) {
    const held = out.get(row.projectId);
    held?.set(row.flow, row.revision);
    held?.set(row.id, row.revision);
  }
  return out;
}

/** Each contract's current (newest approved) version, keyed `<project slug>/<contract slug>`: the anchor of an issue with no requirement. */
export async function currentContracts(
  projectIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>(projectIds.map((id) => [id, new Map()]));
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      projectId: contractVersions.providerProjectId,
      slug: projects.slug,
      contract: contractVersions.contractSlug,
      version: contractVersions.version,
      recordedAt: contractVersions.recordedAt,
    })
    .from(contractVersions)
    .innerJoin(projects, eq(projects.id, contractVersions.providerProjectId))
    .where(
      and(
        inArray(contractVersions.providerProjectId, projectIds),
        eq(contractVersions.approval, 'approved'),
      ),
    );
  const newestFirst = [...rows].sort(
    (a, b) => (b.recordedAt?.getTime() ?? 0) - (a.recordedAt?.getTime() ?? 0),
  );
  for (const row of newestFirst) {
    const held = out.get(row.projectId);
    const key = `${row.slug}/${row.contract}`;
    if (held && !held.has(key)) held.set(key, row.version);
  }
  return out;
}

interface PinnedAnchors {
  key: string;
  designs: Map<string, number>;
  contracts: Map<string, string>;
}

/**
 * For each issue that delivers a requirement, the design revisions and contract versions its
 * requirement's latest baseline pins: the versions both sides built against, which its design and
 * contract verdicts are counted against (requirement-to-delivery, step `verdict-result`).
 */
export async function pinnedAnchorsOf(
  issueIds: readonly string[],
): Promise<Map<string, PinnedAnchors>> {
  const out = new Map<string, PinnedAnchors>();
  if (issueIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT i.id AS issue_id, r.req_seq, p.workflow_id, w.flow, p.design_revision,
           pp.slug AS provider_slug, p.contract_slug, p.contract_version
    FROM issues i
    JOIN requirements r ON r.id = i.requirement_id
    LEFT JOIN requirement_baseline_pins p
      ON p.requirement_id = r.id
     AND (p.revision, p.baseline_seq) = (
           SELECT b.revision, b.seq FROM requirement_baselines b
            WHERE b.requirement_id = r.id
            ORDER BY b.revision DESC, b.seq DESC LIMIT 1)
    LEFT JOIN project_workflows w ON w.id = p.workflow_id
    LEFT JOIN projects pp ON pp.id = p.provider_project_id
    WHERE i.id IN (${sql.join(
      issueIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `)) as unknown as Array<Record<string, unknown>>;
  for (const r of rows) {
    const id = String(r.issue_id);
    const held = out.get(id) ?? {
      key: `REQ-${Number(r.req_seq)}`,
      designs: new Map<string, number>(),
      contracts: new Map<string, string>(),
    };
    if (r.workflow_id != null && r.design_revision != null) {
      held.designs.set(String(r.flow), Number(r.design_revision));
      held.designs.set(String(r.workflow_id), Number(r.design_revision));
    }
    if (r.contract_slug != null && r.contract_version != null) {
      held.contracts.set(
        `${String(r.provider_slug)}/${String(r.contract_slug)}`,
        String(r.contract_version),
      );
    }
    out.set(id, held);
  }
  return out;
}
