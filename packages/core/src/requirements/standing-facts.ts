/**
 * The facts a requirement's standing reads beyond its own rows: each linked issue criterion's
 * latest verdict that is still current evidence with the identity it was judged at, and the latest baseline's design and contract pins
 * beside the revision or version each is approved at now.
 */

import type { ChecklistAnswer } from '@forge/contracts/checklists';
import type { CoverageFile, RequirementAcceptanceDecision } from '@forge/contracts/requirements';
import type { StorefrontDraftPart } from '@forge/contracts/verdict-identity';
import { voidedByReopen } from '@forge/contracts/verified-rule';
import { desc, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import { requirementCriterionVerdicts } from '../db/schema-requirement-verdicts.js';
import { reopenedAtOf, verdictByBuilderSql } from '../issues/index.js';
import { waivedOf } from './acceptance-waived.js';
import { requirementDependents } from './dependents.js';
import type { LiveBuildHolds, StandingIssueCriterion, StandingVerdict } from './standing.js';
import type { CoverageIdentity, StandingRequirementVerdict } from './standing-coverage.js';

type CriterionVerdictRow = {
  criterion_id: string;
  issue_id: string;
  n: number;
  requirement_criterion_id: string;
  verdict: StandingIssueCriterion['verdict'];
  verdict_at: Date | string | null;
  reason: string | null;
  evidence: string[] | null;
  identity_kind: string | null;
  commit_sha: string | null;
  runtime_ref: string | null;
  design_flow: string | null;
  design_workflow_id: string | null;
  design_revision: number | null;
  design_pinned: number | null;
  contract_ref: string | null;
  contract_version: string | null;
  contract_pinned: string | null;
  storefront_drafts: StorefrontDraftPart[] | null;
  storefront_environment: string | null;
  by_builder: boolean | null;
  authored: boolean | null;
};

/** The identity a stored verdict names, as coverage checks it; null where it names none. */
function identityOf(r: CriterionVerdictRow): CoverageIdentity | null {
  switch (r.identity_kind) {
    case 'commit':
      return r.commit_sha ? { kind: 'commit', sha: r.commit_sha } : null;
    case 'commit_unresolved':
      return r.commit_sha ? { kind: 'commit_unresolved', sha: r.commit_sha } : null;
    case 'runtime':
      return r.runtime_ref ? { kind: 'runtime', ref: r.runtime_ref } : null;
    case 'design':
      return r.design_workflow_id && r.design_revision !== null
        ? {
            kind: 'design',
            workflow: r.design_flow ?? r.design_workflow_id,
            revision: Number(r.design_revision),
            pinned: r.design_pinned === null ? null : Number(r.design_pinned),
          }
        : null;
    case 'contract':
      return r.contract_ref && r.contract_version
        ? {
            kind: 'contract',
            ref: r.contract_ref,
            version: r.contract_version,
            pinned: r.contract_pinned,
          }
        : null;
    case 'storefront_draft':
      return {
        kind: 'storefront_draft',
        drafts: r.storefront_drafts ?? [],
        environment: r.storefront_environment ?? '',
      };
    default:
      return null;
  }
}

/** The files kept on the issues, by issue and name: what a verdict's evidence cites by name. */
async function filesOf(issueIds: readonly string[]): Promise<Map<string, CoverageFile>> {
  const out = new Map<string, CoverageFile>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({
      id: issueAttachments.id,
      issueId: issueAttachments.issueId,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
    })
    .from(issueAttachments)
    .where(inArray(issueAttachments.issueId, [...new Set(issueIds)]));
  for (const r of rows) {
    const key = `${r.issueId}\u0000${r.name}`;
    if (!out.has(key)) out.set(key, { attachmentId: r.id, name: r.name, mime: r.mime });
  }
  return out;
}

/**
 * Each live traced criterion of `issueIds` with its latest verdict and what that verdict names: a
 * design or contract identity beside the revision or version the traced requirement's latest
 * baseline pins for it, the anchor coverage holds it to (`standing-coverage.ts:resolve`). Every
 * earlier verdict since the issue's latest reopen comes with it, newest first, so coverage can read
 * past a newer one that is not the judge's (`standing-coverage.ts:judgesOf`).
 */
export async function issueCriteriaOf(
  issueIds: readonly string[],
  ex: Pick<Tx, 'execute'> = db,
): Promise<StandingIssueCriterion[]> {
  if (issueIds.length === 0) return [];
  const rows = (await ex.execute(sql`
    SELECT c.id AS criterion_id, c.issue_id, c.n, c.requirement_criterion_id, v.verdict, v.verdict_at, v.reason, v.evidence,
           v.identity_kind,
           v.commit_sha, v.runtime_ref, w.flow AS design_flow, v.design_workflow_id,
           v.design_revision, dp.design_revision AS design_pinned, v.contract_ref,
           v.contract_version, cp.contract_version AS contract_pinned, v.storefront_drafts,
           v.storefront_environment,
           (${verdictByBuilderSql({
             issueId: sql`c.issue_id`,
             authorUser: sql`v.author_user_id`,
             authorDevice: sql`v.author_device_id`,
             at: sql`v.verdict_at`,
             runSession: sql`v.run_session_id`,
           })}) AS by_builder,
           (v.author_user_id IS NOT NULL OR v.author_device_id IS NOT NULL) AS authored
      FROM issue_criteria c
      JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
      LEFT JOIN LATERAL (
        SELECT cv.id, cv.verdict, cv.created_at AS verdict_at, cv.reason, cv.evidence, cv.identity_kind,
               cv.commit_sha,
               cv.runtime_ref, cv.design_workflow_id, cv.design_revision, cv.contract_ref,
               cv.contract_version, cv.storefront_drafts,
               cv.storefront_environment, cv.author_user_id, cv.author_device_id, cv.run_session_id
          FROM criterion_verdicts cv
         WHERE cv.criterion_id = c.id
      ) v ON true
      LEFT JOIN project_workflows w ON w.id = v.design_workflow_id
      LEFT JOIN LATERAL (
        SELECT b.revision, b.seq FROM requirement_baselines b
         WHERE b.requirement_id = rc.requirement_id
         ORDER BY b.revision DESC, b.seq DESC LIMIT 1
      ) lb ON true
      LEFT JOIN LATERAL (
        SELECT p.design_revision FROM requirement_baseline_pins p
         WHERE p.requirement_id = rc.requirement_id AND p.revision = lb.revision
           AND p.baseline_seq = lb.seq AND p.workflow_id = v.design_workflow_id
         LIMIT 1
      ) dp ON true
      LEFT JOIN LATERAL (
        SELECT p.contract_version FROM requirement_baseline_pins p
          JOIN projects pp ON pp.id = p.provider_project_id
         WHERE p.requirement_id = rc.requirement_id AND p.revision = lb.revision
           AND p.baseline_seq = lb.seq AND p.contract_slug IS NOT NULL
           AND pp.slug || '/' || p.contract_slug = v.contract_ref
         LIMIT 1
      ) cp ON true
     WHERE c.issue_id IN (${sql.join(
       issueIds.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND c.retired_at IS NULL
     ORDER BY c.issue_id, c.position, c.n, v.verdict_at DESC NULLS LAST, v.id DESC`)) as unknown as CriterionVerdictRow[];
  // A verdict recorded at or before the issue's latest reopen is evidence about a build the
  // reopen rejected (`issues/release-evidence.ts:reopenedAtOf`), so coverage reads it as not judged
  const reopened = await reopenedAtOf(ex, issueIds);
  const files = await filesOf(
    rows.flatMap((r) => ((r.evidence ?? []).length > 0 ? [r.issue_id] : [])),
  );
  const voidedOf = (r: CriterionVerdictRow): boolean =>
    voidedByReopen({ recordedAt: r.verdict_at }, reopened.get(r.issue_id) ?? null);
  const verdictOf = (r: CriterionVerdictRow, voided = voidedOf(r)): StandingVerdict => {
    return {
      verdict: voided ? null : r.verdict,
      verdictAt: voided || !r.verdict_at ? null : new Date(r.verdict_at),
      note: voided || !r.reason?.trim() ? null : r.reason,
      files: voided
        ? []
        : (r.evidence ?? []).flatMap((name) => files.get(`${r.issue_id}\u0000${name}`) ?? []),
      identity: voided || r.verdict === null ? null : identityOf(r),
      byBuilder: !voided && r.verdict !== null && r.by_builder === true,
      authored: !voided && r.verdict !== null && r.authored === true,
      recordedAt: voided || !r.verdict_at ? null : new Date(r.verdict_at),
    };
  };
  const byCriterion = new Map<string, CriterionVerdictRow[]>();
  for (const r of rows)
    byCriterion.set(r.criterion_id, [...(byCriterion.get(r.criterion_id) ?? []), r]);
  return [...byCriterion.values()].map(([latest, ...older]) => {
    const r = latest as CriterionVerdictRow;
    return {
      issueId: r.issue_id,
      n: r.n,
      requirementCriterionId: r.requirement_criterion_id,
      ...verdictOf(r),
      earlier: older.map((v) => verdictOf(v)).filter((v) => v.verdict !== null),
      // kept beside the void for coverage to weigh on a landing (`standing-coverage.ts:standsAtLanding`)
      ...(voidedOf(r) && r.verdict !== null ? { beforeReopen: verdictOf(r, false) } : {}),
    };
  });
}

/**
 * What the live build holds of the commits `rows`' judgements name, directly or through the runtime
 * that served them, and of the commits the verdicts recorded at the requirement itself name
 * (`own`, ISS-588); null where none names either.
 */
export async function liveBuildOf(
  projectId: string,
  rows: readonly StandingIssueCriterion[],
  own: readonly Pick<StandingRequirementVerdict, 'commit'>[] = [],
): Promise<LiveBuildHolds | null> {
  const judged = rows
    .flatMap((r) => [r, ...(r.earlier ?? [])])
    .filter((r) => r.verdict !== null && r.verdict !== 'skipped');
  const commits = [
    ...judged.flatMap((r) => (r.identity?.kind === 'commit' ? [r.identity.sha] : [])),
    ...own.flatMap((v) => (v.commit ? [v.commit] : [])),
  ];
  const runtimes = judged.flatMap((r) => (r.identity?.kind === 'runtime' ? [r.identity.ref] : []));
  const voidedAtCommit = rows.some((r) => r.beforeReopen?.identity?.kind === 'commit');
  if (commits.length === 0 && runtimes.length === 0 && !voidedAtCommit) return null;
  // With no production environment each verdict is weighed on its own issue's landing instead.
  const landed = await requirementDependents().landedBuildHolds(projectId, [
    ...new Set(rows.map((r) => r.issueId)),
  ]);
  if (landed) return landed;
  if (commits.length === 0 && runtimes.length === 0) return null;
  return requirementDependents().liveBuildHolds(projectId, { commits, runtimes });
}

type PinRow = {
  requirement_id: string;
  flow: string;
  title: string | null;
  pinned: number | null;
  approved: number | null;
};

export async function latestPinsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT rw.requirement_id, w.flow, w.document->>'title' AS title, p.design_revision AS pinned, w.approved_revision AS approved
      FROM requirement_workflows rw
      JOIN project_workflows w ON w.id = rw.workflow_id
      JOIN LATERAL (
             SELECT b.revision, b.seq FROM requirement_baselines b
              WHERE b.requirement_id = rw.requirement_id
              ORDER BY b.revision DESC, b.seq DESC LIMIT 1) lb ON true
      LEFT JOIN requirement_baseline_pins p
        ON p.requirement_id = rw.requirement_id AND p.workflow_id = rw.workflow_id
       AND p.revision = lb.revision AND p.baseline_seq = lb.seq
     WHERE rw.requirement_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})`)) as unknown as PinRow[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    flow: r.flow,
    title: r.title,
    pinned: r.pinned,
    approved: r.approved,
  }));
}

type ContractPinRow = {
  requirement_id: string;
  provider_project_id: string;
  contract_slug: string;
  contract_version: string;
};

/** The contract pins of each requirement's latest baseline. */
export async function latestContractPinsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT p.requirement_id, p.provider_project_id, p.contract_slug, p.contract_version
      FROM requirement_baseline_pins p
     WHERE p.requirement_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND p.contract_slug IS NOT NULL
       AND (p.revision, p.baseline_seq) = (
             SELECT b.revision, b.seq FROM requirement_baselines b
              WHERE b.requirement_id = p.requirement_id
              ORDER BY b.revision DESC, b.seq DESC LIMIT 1)`)) as unknown as ContractPinRow[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    providerProjectId: r.provider_project_id,
    contractSlug: r.contract_slug,
    contractVersion: r.contract_version,
  }));
}

/**
 * Each of `ids` that stands accepted by decision (REQ-74): its latest move into accepted waived one or
 * more of the acceptance checklist's blocking items (`checklists.ts:waivedEvaluation`). The one
 * reading of "accepted by decision": the standing, the duplicate check and the delivered reads all
 * ask it, so none counts what a decision waived as proven.
 */
export async function acceptanceDecisionsOf(
  ids: readonly string[],
): Promise<Map<string, RequirementAcceptanceDecision>> {
  return (await statusFactsOf(ids)).decisions;
}

/**
 * Read off each requirement's latest kernel transition in one statement: when its status last moved,
 * else when it was filed (the start of its time in the state it stands in, REQ-29 BC-5's age; a
 * placement, a short name or any other edit moves no status, so it never restarts that time), and,
 * for one standing accepted, whether that move into accepted was a decision (`acceptanceDecisionsOf`).
 */
export async function statusFactsOf(ids: readonly string[]): Promise<{
  since: Map<string, Date>;
  decisions: Map<string, RequirementAcceptanceDecision>;
}> {
  if (ids.length === 0) return { since: new Map(), decisions: new Map() };
  const rows = (await db.execute(sql`
    SELECT r.id, r.status, COALESCE(last.created_at, r.created_at) AS at,
           last.to_status, last.reason, last.checklist_answers AS answers
      FROM requirements r
      LEFT JOIN LATERAL (
        SELECT kt.created_at, kt.to_status, kt.reason, kt.checklist_answers
          FROM kernel_transitions kt
         WHERE kt.entity = 'requirement' AND kt.entity_id = r.id
         ORDER BY kt.created_at DESC
         LIMIT 1
      ) last ON true
     WHERE r.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})`)) as unknown as Array<{
    id: string;
    status: string;
    at: Date | string;
    to_status: string | null;
    reason: string | null;
    answers: ChecklistAnswer[] | null;
  }>;
  const since = new Map<string, Date>();
  const decisions = new Map<string, RequirementAcceptanceDecision>();
  for (const r of rows) {
    since.set(r.id, new Date(r.at));
    if (r.status !== 'accepted' || r.to_status !== 'accepted') continue;
    const waived = waivedOf({ answers: r.answers ?? [] });
    if (waived.length === 0) continue;
    decisions.set(r.id, {
      reason: r.reason ?? '',
      decidedAt: new Date(r.at).toISOString(),
      waived,
    });
  }
  return { since, decisions };
}

/** When each linked issue last closed (closed ones only) and first moved past draft and open. */
export async function issueTimesOf(linked: readonly { id: string; status: string }[]) {
  const [closedAt, startedAt] = await Promise.all([
    closedAtOf(linked.filter((i) => i.status === 'closed').map((i) => i.id)),
    startedAtOf(linked.map((i) => i.id)),
  ]);
  return { closedAt, startedAt };
}

/** When each issue first moved past draft and open: the work on it started. */
async function startedAtOf(issueIds: readonly string[]): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT entity_id, min(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status NOT IN ('draft', 'open')
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/** When each closed issue last moved to closed, from its kernel transitions. */
export async function closedAtOf(issueIds: readonly string[]): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT entity_id, max(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'closed'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/** Each requirement's linked designs that hold no approved revision, which an agree refuses. */
export async function unapprovedDesignsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT rw.requirement_id, w.flow, w.document->>'title' AS title, w.design_status
      FROM requirement_workflows rw
      JOIN project_workflows w ON w.id = rw.workflow_id
     WHERE w.approved_revision IS NULL
       AND rw.requirement_id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
     ORDER BY w.flow`)) as unknown as {
    requirement_id: string;
    flow: string;
    title: string | null;
    design_status: string | null;
  }[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    flow: r.flow,
    title: r.title ?? r.flow,
    designStatus: r.design_status,
  }));
}

/** One requirement-level verdict as coverage reads it, with the requirement it belongs to and its author. */
export type RequirementVerdictRead = StandingRequirementVerdict & {
  requirementId: string;
  authorUserId: string | null;
  authorAgency: 'human' | 'agent';
};

type RequirementVerdictRow = typeof requirementCriterionVerdicts.$inferSelect;

/** A requirement-level verdict row as coverage reads it. */
export function verdictReadOf(r: RequirementVerdictRow): RequirementVerdictRead {
  return {
    id: r.id,
    requirementId: r.requirementId,
    requirementCriterionId: r.requirementCriterionId,
    verdict: r.verdict,
    verdictAt: r.createdAt,
    note: r.reason,
    evidence: r.evidence,
    commit: r.commitSha,
    authored: r.authorUserId !== null || r.authorDeviceId !== null,
    authorUserId: r.authorUserId,
    authorAgency: r.authorAgency,
  };
}

/** Every verdict recorded at the requirement on `ids`, newest first. */
export async function requirementVerdictsOf(
  ids: readonly string[],
  ex: Pick<Tx, 'select'> = db,
): Promise<RequirementVerdictRead[]> {
  if (ids.length === 0) return [];
  const rows = await ex
    .select()
    .from(requirementCriterionVerdicts)
    .where(inArray(requirementCriterionVerdicts.requirementId, [...ids]))
    .orderBy(desc(requirementCriterionVerdicts.createdAt));
  return rows.map(verdictReadOf);
}
