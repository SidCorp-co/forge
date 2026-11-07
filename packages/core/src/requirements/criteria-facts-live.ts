/**
 * Each issue's traced criteria computed from their rows, live: the one definition the stored facts
 * (`criteria-facts.ts`) are written from and the drift sweep weighs them against. Readers read
 * `standing-facts.ts:issueCriteriaOf`, which answers from the stored facts.
 */

import type { CoverageFile } from '@forge/contracts/requirements';
import type { StorefrontDraftPart } from '@forge/contracts/verdict-identity';
import { BUILDER_PASS_CUTOVER } from '@forge/contracts/verified-rule';
import { inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { issueAttachments } from '../db/schema.js';
import {
  builderFactsMarkedSql,
  readWithBuilderFacts,
  reopenedAtOf,
  voidedUpTo,
} from '../issues/index.js';
import type { StandingIssueCriterion, StandingVerdict } from './standing.js';
import type { CoverageIdentity } from './standing-coverage.js';

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
  release_version?: string | null;
  storefront_drafts: StorefrontDraftPart[] | null;
  storefront_environment: string | null;
  covers: string[] | null;
  by_builder: boolean | null;
  /** The builder fact is owed for its verdict (`issues/builder-facts.ts:builderFactsMarkedSql`). */
  fact_owed?: boolean | null;
  fact_missing?: boolean | null;
  authored: boolean | null;
  /** The class the issue's recorded design gives the criterion; null where none is recorded. */
  criterion_class?: string | null;
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
    case 'release':
      return r.release_version ? { kind: 'release', version: r.release_version } : null;
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
 * What makes two verdicts on one criterion alike to every reader of its history: what it says, the
 * identity it names, who recorded it (the builder, an author, before the builder cutover:
 * `@forge/contracts/verified-rule:judgesVerdict`), and which side of the issue's latest reopen it
 * fell (`issues/release-evidence.ts:voidedUpTo`, read in milliseconds as the history is). Each reader
 * takes the newest verdict meeting a test of these, or the set of identities they name, so the
 * newest of each class answers as every verdict does (ISS-1070 r6): a criterion judged six hundred
 * times on two commits reads a handful of rows.
 */
const VERDICT_CLASS_SQL = sql`cv.verdict, cv.identity_kind, cv.commit_sha, cv.runtime_ref,
  cv.design_workflow_id, cv.design_revision, cv.contract_ref, cv.contract_version,
  cv.release_version, cv.storefront_drafts, cv.storefront_environment, cv.covers,
  vb.by_builder, vb.verdict_id IS NULL,
  (cv.author_user_id IS NOT NULL OR cv.author_device_id IS NOT NULL),
  cv.created_at < ${BUILDER_PASS_CUTOVER}::timestamptz,
  date_trunc('milliseconds', cv.created_at) <= c.reopened_at`;

/**
 * Where set, every verdict is read rather than the newest of each class: the answer the classes are
 * proven equal to (`tests/integration/coverage-verdict-classes-e2e.test.ts`). Nothing else sets it.
 */
export const everyVerdictRead = { on: false };

export async function liveIssueCriteria(
  issueIds: readonly string[],
  ex: Pick<Tx, 'execute'>,
  asReturned: readonly string[],
): Promise<StandingIssueCriterion[]> {
  if (issueIds.length === 0) return [];
  // a criterion's facts are read once per criterion, and a pin only for a verdict naming a design or
  // a contract: per verdict, they were read for every verdict ever recorded (ISS-1070 r4)
  // the builder rule is read from the model each write keeps (`issues/builder-facts.ts`)
  // A verdict recorded at or before the issue's latest reopen, on a criterion that was not passing
  // then, is evidence about a build the reopen rejected (`issues/release-evidence.ts:voidedUpTo`,
  // ISS-845), so coverage reads it as not judged; a pass stands across the reopen
  const reopened = await reopenedAtOf(ex, issueIds, asReturned);
  const reopenedJson = JSON.stringify(
    Object.fromEntries([...reopened].map(([id, at]) => [id, at.toISOString()])),
  );
  const kept = everyVerdictRead.on ? sql`true` : sql`v.kept = 1`;
  const rows = await readWithBuilderFacts(
    ex,
    async () =>
      (await ex.execute(sql`
    WITH crit AS (
      SELECT c.id, c.issue_id, c.n, c.position, c.requirement_criterion_id, rc.requirement_id,
             (SELECT d.criterion_class FROM issue_design_criteria d
               WHERE d.criterion_id = c.id LIMIT 1) AS criterion_class,
             ${builderFactsMarkedSql(sql`c.issue_id`)} AS issue_marked,
             (${reopenedJson}::jsonb ->> c.issue_id::text)::timestamptz AS reopened_at
        FROM issue_criteria c
        JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
       WHERE c.issue_id = ANY(${uuidArray(issueIds)})
         AND c.retired_at IS NULL
    ),
    -- the asked issues' builder facts, read once by their issue: looked up per verdict they cost a
    -- descent of the key for each one
    facts AS MATERIALIZED (
      SELECT verdict_id, by_builder FROM verdict_builder_facts
       WHERE issue_id = ANY(${uuidArray(issueIds)})
    ),
    -- every criterion's verdicts ranked in their class at once, so each fact table is joined once
    ranked AS (
      SELECT cv.id, cv.criterion_id, cv.verdict, cv.created_at AS verdict_at, cv.reason, cv.evidence,
             cv.identity_kind, cv.commit_sha, cv.runtime_ref, cv.design_workflow_id, cv.design_revision,
             cv.contract_ref, cv.contract_version, cv.release_version, cv.storefront_drafts,
             cv.storefront_environment, cv.covers, cv.author_user_id, cv.author_device_id,
             vb.by_builder, vb.verdict_id IS NULL AS fact_missing,
             row_number() OVER (PARTITION BY cv.criterion_id, ${VERDICT_CLASS_SQL}
                                ORDER BY cv.created_at DESC, cv.id DESC) AS kept
        FROM crit c
        JOIN criterion_verdicts cv ON cv.criterion_id = c.id
        LEFT JOIN facts vb ON vb.verdict_id = cv.id
       WHERE cv.issue_id = ANY(${uuidArray(issueIds)})
    )
    SELECT c.id AS criterion_id, c.issue_id, c.n, c.requirement_criterion_id, v.verdict, v.verdict_at, v.reason, v.evidence,
           v.identity_kind,
           v.commit_sha, v.runtime_ref, w.flow AS design_flow, v.design_workflow_id,
           v.design_revision,
           CASE WHEN v.design_workflow_id IS NOT NULL THEN (
             SELECT p.design_revision FROM requirement_baseline_pins p
              WHERE (p.requirement_id, p.revision, p.baseline_seq) = (
                      SELECT b.requirement_id, b.revision, b.seq FROM requirement_baselines b
                       WHERE b.requirement_id = c.requirement_id
                       ORDER BY b.revision DESC, b.seq DESC LIMIT 1)
                AND p.workflow_id = v.design_workflow_id
              LIMIT 1) END AS design_pinned,
           v.contract_ref,
           v.contract_version,
           CASE WHEN v.contract_ref IS NOT NULL THEN (
             SELECT p.contract_version FROM requirement_baseline_pins p
               JOIN projects pp ON pp.id = p.provider_project_id
              WHERE (p.requirement_id, p.revision, p.baseline_seq) = (
                      SELECT b.requirement_id, b.revision, b.seq FROM requirement_baselines b
                       WHERE b.requirement_id = c.requirement_id
                       ORDER BY b.revision DESC, b.seq DESC LIMIT 1)
                AND p.contract_slug IS NOT NULL
                AND pp.slug || '/' || p.contract_slug = v.contract_ref
              LIMIT 1) END AS contract_pinned,
           v.release_version, v.storefront_drafts,
           v.storefront_environment, v.covers,
           v.by_builder,
           (v.id IS NOT NULL AND (v.fact_missing OR c.issue_marked)) AS fact_owed,
           coalesce(v.fact_missing, false) AS fact_missing,
           (v.author_user_id IS NOT NULL OR v.author_device_id IS NOT NULL) AS authored,
           c.criterion_class
      FROM crit c
      LEFT JOIN ranked v ON v.criterion_id = c.id AND ${kept}
      LEFT JOIN project_workflows w ON w.id = v.design_workflow_id
     ORDER BY c.issue_id, c.position, c.n, v.verdict_at DESC NULLS LAST, v.id DESC`)) as unknown as CriterionVerdictRow[],
    (r) => (r.fact_owed ? { issueId: r.issue_id, missing: r.fact_missing === true } : null),
  );
  const files = await filesOf(
    rows.flatMap((r) => ((r.evidence ?? []).length > 0 ? [r.issue_id] : [])),
  );
  const historyOf = new Map<string, Array<{ verdict: string | null; at: Date | string | null }>>();
  const issueOf = new Map<string, string>();
  for (const r of rows) {
    historyOf.set(r.criterion_id, [
      ...(historyOf.get(r.criterion_id) ?? []),
      { verdict: r.verdict, at: r.verdict_at },
    ]);
    issueOf.set(r.criterion_id, r.issue_id);
  }
  const voidedUntil = new Map(
    [...historyOf].map(
      ([id, list]) => [id, voidedUpTo(list, reopened.get(issueOf.get(id) ?? ''))] as const,
    ),
  );
  const voidedOf = (r: CriterionVerdictRow): boolean => {
    const at = voidedUntil.get(r.criterion_id);
    return !!at && !!r.verdict_at && new Date(r.verdict_at).getTime() <= at.getTime();
  };
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
      covers: voided ? null : r.covers,
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
      ...(r.criterion_class === 'observable' ? { liveOnly: true } : {}),
      ...verdictOf(r),
      earlier: older.map((v) => verdictOf(v)).filter((v) => v.verdict !== null),
      // kept beside the void for coverage to weigh on a landing (`standing-coverage.ts:standsAtLanding`)
      ...(voidedOf(r) && r.verdict !== null ? { beforeReopen: verdictOf(r, false) } : {}),
    };
  });
}
