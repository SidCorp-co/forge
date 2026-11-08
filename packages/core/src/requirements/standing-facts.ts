/**
 * The facts a requirement's standing reads beyond its own rows: each linked issue criterion's
 * latest verdict that is still current evidence with the identity it was judged at, and the latest baseline's design and contract pins
 * beside the revision or version each is approved at now.
 */

import type { ChecklistAnswer } from '@forge/contracts/checklists';
import type { RequirementAcceptanceDecision } from '@forge/contracts/requirements';
import { desc, inArray, sql } from 'drizzle-orm';
import { type ItemDecision, itemDecisionOf } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { memoizedPerId, rowsPerId } from '../db/read-memo.js';
import { requirementCriterionVerdicts } from '../db/schema-requirement-verdicts.js';
import { requirements } from '../db/schema-requirements.js';
import { waivedOf } from './acceptance-waived.js';
import { storedIssueCriteria } from './criteria-facts.js';
import { everyVerdictRead, liveIssueCriteria } from './criteria-facts-live.js';
import type { StandingIssueCriterion } from './standing.js';
import type { StandingRequirementVerdict } from './standing-coverage.js';

export { everyVerdictRead };

/**
 * Each live traced criterion of `issueIds` with its latest verdict and what that verdict names
 * (`criteria-facts-live.ts:liveIssueCriteria`), answered from the facts each write keeps
 * (`criteria-facts.ts`, ISS-1070 r7): a fact owed is written from the live read first. Inside a
 * transaction, read as if back from a reopen, or with every verdict asked for, it is the live read.
 */
export function issueCriteriaOf(
  issueIds: readonly string[],
  ex: Pick<Tx, 'execute'> = db,
  /** Issues read as if back from their reopen now (`issues/release-evidence.ts:reopenedAtOf`). */
  asReturned: readonly string[] = [],
): Promise<StandingIssueCriterion[]> {
  if (ex !== db) return liveIssueCriteria(issueIds, ex, asReturned);
  const stored = asReturned.length === 0 && !everyVerdictRead.on;
  // an issue's criteria are its own whichever issues are asked beside it: a read's asks, every
  // project's of a person's, are read together where they read the pool (ISS-1070 r6)
  return rowsPerId(
    stored ? 'issueCriteria:stored' : `issueCriteria:${[...asReturned].sort().join(',')}`,
    issueIds,
    (some) => (stored ? storedIssueCriteria(some) : liveIssueCriteria(some, ex, asReturned)),
    (c) => c.issueId,
  );
}

type PinRow = {
  requirement_id: string;
  flow: string;
  title: string | null;
  pinned: number | null;
  approved: number | null;
};

/** Each requirement's linked designs with the revision its latest baseline pins and the one approved. */
export function latestPinsOf(ids: readonly string[]) {
  return rowsPerId('latestPins', ids, latestPinsRead, (r) => r.requirementId);
}

async function latestPinsRead(ids: readonly string[]) {
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
export function latestContractPinsOf(ids: readonly string[]) {
  return rowsPerId('latestContractPins', ids, latestContractPinsRead, (r) => r.requirementId);
}

async function latestContractPinsRead(ids: readonly string[]) {
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
/**
 * The project and status of each of the requirements `ids`: every project's asks in a read across
 * projects, one statement (`db/read-memo.ts:memoizedPerId`); each project's feedback list read its
 * own (ISS-1070 r8).
 */
export async function requirementStatusesOf(ids: readonly string[]) {
  const held = await memoizedPerId('requirementStatus', ids, async (some) => {
    const rows = await db
      .select({
        id: requirements.id,
        projectId: requirements.projectId,
        status: requirements.status,
      })
      .from(requirements)
      .where(inArray(requirements.id, [...some]));
    return new Map(rows.map((r) => [r.id, r]));
  });
  return [...held.values()];
}

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
export async function statusFactsOf(ids: readonly string[]): Promise<StatusFacts> {
  const read = await memoizedPerId('statusFacts', ids, async (some) => {
    const { since, decisions, held } = await statusFactsRead(some);
    return new Map(
      [...since].map(([id, at]) => [
        id,
        { since: at, decision: decisions.get(id) ?? null, held: held.get(id) ?? null },
      ]),
    );
  });
  return {
    since: new Map([...read].map(([id, f]) => [id, f.since])),
    decisions: new Map(
      [...read].flatMap(([id, f]) => (f.decision ? [[id, f.decision] as const] : [])),
    ),
    held: new Map([...read].flatMap(([id, f]) => (f.held ? [[id, f.held] as const] : []))),
  };
}

interface StatusFacts {
  since: Map<string, Date>;
  decisions: Map<string, RequirementAcceptanceDecision>;
  /**
   * Its latest reasoned decision comment (ISS-1078), read in the same statement: what holds a move the
   * rule would make (`standing-held.ts:heldByDecision`).
   */
  held: Map<string, ItemDecision>;
}

async function statusFactsRead(ids: readonly string[]): Promise<StatusFacts> {
  if (ids.length === 0) return { since: new Map(), decisions: new Map(), held: new Map() };
  const rows = (await db.execute(sql`
    SELECT r.id, r.status, COALESCE(last.created_at, r.created_at) AS at,
           last.to_status, last.reason, last.checklist_answers AS answers,
           decided.created_at AS decided_at, decided.decision AS decided
      FROM requirements r
      LEFT JOIN LATERAL (
        SELECT c.created_at, c.decision
          FROM comments c
         WHERE c.requirement_id = r.id AND c.intent = 'decision'
           AND btrim(coalesce(c.decision ->> 'reason', '')) <> ''
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 1
      ) decided ON true
      LEFT JOIN LATERAL (
        SELECT kt.created_at, kt.to_status, kt.reason, kt.checklist_answers
          FROM kernel_transitions kt
         WHERE kt.entity = 'requirement' AND kt.entity_id = r.id
         ORDER BY kt.created_at DESC
         LIMIT 1
      ) last ON true
     WHERE r.id = ANY(${uuidArray(ids)})`)) as unknown as Array<{
    id: string;
    status: string;
    at: Date | string;
    to_status: string | null;
    reason: string | null;
    answers: ChecklistAnswer[] | null;
    decided_at: Date | string | null;
    decided: Parameters<typeof itemDecisionOf>[2];
  }>;
  const since = new Map<string, Date>();
  const decisions = new Map<string, RequirementAcceptanceDecision>();
  const held = new Map<string, ItemDecision>();
  for (const r of rows) {
    since.set(r.id, new Date(r.at));
    const decided = r.decided_at ? itemDecisionOf(r.id, new Date(r.decided_at), r.decided) : null;
    if (decided) held.set(r.id, decided);
    if (r.status !== 'accepted' || r.to_status !== 'accepted') continue;
    const waived = waivedOf({ answers: r.answers ?? [] });
    if (waived.length === 0) continue;
    decisions.set(r.id, {
      reason: r.reason ?? '',
      decidedAt: new Date(r.at).toISOString(),
      waived,
    });
  }
  return { since, decisions, held };
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
function startedAtOf(issueIds: readonly string[]): Promise<Map<string, Date>> {
  return memoizedPerId('startedAt', issueIds, startedAtRead);
}

async function startedAtRead(issueIds: readonly string[]): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT entity_id, min(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status NOT IN ('draft', 'open')
       AND entity_id = ANY(${uuidArray(issueIds)})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/** When each closed issue last moved to closed, from its kernel transitions. */
export function closedAtOf(issueIds: readonly string[]): Promise<Map<string, Date>> {
  return memoizedPerId('closedAt', issueIds, closedAtRead);
}

async function closedAtRead(issueIds: readonly string[]): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT entity_id, max(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'closed'
       AND entity_id = ANY(${uuidArray(issueIds)})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/** Each requirement's linked designs that hold no approved revision, which an agree refuses. */
export function unapprovedDesignsOf(ids: readonly string[]) {
  return rowsPerId('unapprovedDesigns', ids, unapprovedDesignsRead, (r) => r.requirementId);
}

async function unapprovedDesignsRead(ids: readonly string[]) {
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
  /** The run session that recorded it; null where the call named none (`verdicts.ts`). */
  runSession: string | null;
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
    release: r.releaseVersion,
    authored: r.authorUserId !== null || r.authorDeviceId !== null,
    authorUserId: r.authorUserId,
    authorAgency: r.authorAgency,
    runSession: r.runSessionId,
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
