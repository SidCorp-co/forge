/**
 * ISS-55 — reads and writes of `issue_criteria` and `criterion_verdicts`.
 *
 * Criteria are written whole (a plan's PUT, or a write of `acceptance_criteria` text), or one wording
 * is corrected in place, keeping its row and verdicts (`criterion-reword.ts`). Each criterion
 * written is matched to a live row by its wording before its number (`match.ts:matchCriteria`,
 * ISS-567): an unchanged wording keeps its row, its trace and its verdicts even where its number
 * moved, a reworded one is retired and re-added so the verdicts on the old wording stop counting,
 * and a removed one is retired. A repeated wording that would have to move is refused
 * CRITERIA_RENUMBER_AMBIGUOUS rather than guessed. Verdicts are only ever inserted; the latest per
 * live criterion is the one the gate and the UI read.
 */

import type { CriteriaRefusalCode } from '@forge/contracts/issues';
import type { ActorAgency } from '@forge/contracts/permissions';
import type {
  StorefrontDraftPart,
  VerdictCorroboration,
  VerdictDraftReading,
} from '@forge/contracts/verdict-identity';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import {
  issueCriteria,
  type VerdictIdentityKind,
  type VerdictValue,
} from '../../db/schema-issue-criteria.js';
import { refuser } from '../../lib/refusal.js';
import { tracedCodesOf, traceWordingsOf } from '../ports.js';
import {
  parseCriteriaText,
  renderCriteriaText,
  strayTraceTagsOf,
  TRACE_TAG_SHAPE,
  traceTagOf,
} from './criteria-text.js';
import { failureOwnedElsewhere } from './fail-owner.js';
import {
  ambiguousDetail,
  droppedTraceDetail,
  droppedTraces,
  matchCriteria,
  sameCriteria,
} from './match.js';
import { liveWordingAt } from './trace-wording.js';

export const refuseCriteria = refuser<CriteriaRefusalCode>('CRITERIA_REFUSED');

// status-tuple: differs — not ISSUE_DISPATCH_TERMINAL_STATUSES: where verdicts were earned, so the wording is frozen
const LOCKED_STATUSES: ReadonlySet<string> = new Set(['awaiting_release', 'closed', 'dropped']);

export interface CriterionInput {
  readonly n: number;
  readonly statement: string;
  readonly requirementCriterionId?: string | null | undefined;
}

export interface LatestVerdict {
  readonly id: string;
  readonly verdict: VerdictValue;
  readonly reason: string | null;
  readonly identityKind: VerdictIdentityKind | null;
  readonly commitSha: string | null;
  readonly runtimeRef: string | null;
  readonly designWorkflowId: string | null;
  readonly designFlow: string | null;
  readonly designRevision: number | null;
  readonly contractRef: string | null;
  readonly contractVersion: string | null;
  /** Every workflow draft a storefront_draft verdict was judged on, in the order written. */
  readonly storefrontDrafts: readonly StorefrontDraftPart[] | null;
  readonly storefrontEnvironment: string | null;
  readonly corroboration: VerdictDraftReading | null;
  readonly corroborationNote: string | null;
  readonly evidence: readonly string[];
  /** The kept probe this verdict rests on (ISS-469), or null. */
  readonly probeId: string | null;
  readonly authorAgency: ActorAgency;
  readonly backfilled: boolean;
  readonly createdAt: string;
}

export interface CriterionWithVerdict {
  readonly id: string;
  readonly n: number;
  readonly statement: string;
  readonly position: number;
  readonly requirementCriterionId: string | null;
  readonly latest: LatestVerdict | null;
}

type LiveRow = {
  id: string;
  n: number;
  statement: string;
  position: number;
  requirementCriterionId: string | null;
};

export async function liveRows(tx: Tx, issueId: string): Promise<LiveRow[]> {
  return tx
    .select({
      id: issueCriteria.id,
      n: issueCriteria.n,
      statement: issueCriteria.statement,
      position: issueCriteria.position,
      requirementCriterionId: issueCriteria.requirementCriterionId,
    })
    .from(issueCriteria)
    .where(and(eq(issueCriteria.issueId, issueId), isNull(issueCriteria.retiredAt)));
}

/** The field a criteria write came through, which its refusals name. */
type CriteriaPath = '/criteria' | '/acceptanceCriteria';

/**
 * Make the issue's live criteria exactly `desired`, in its order. Refused CRITERIA_LOCKED where the
 * set would change at a status whose verdicts were earned on it, and CRITERIA_RENUMBER_AMBIGUOUS
 * where a repeated wording would have to move. A kept row whose number moves is first parked on a
 * number above every live and desired one, so a swap never holds two live rows on one number
 * (`issue_criteria_live_n_uq`).
 */
async function applyCriteria(
  tx: Tx,
  issue: { id: string; status: string },
  desired: readonly CriterionInput[],
  path: CriteriaPath,
): Promise<void> {
  const live = await liveRows(tx, issue.id);
  const same = sameCriteria(live, desired);
  if (!same && LOCKED_STATUSES.has(issue.status)) {
    throw refuseCriteria(
      'CRITERIA_LOCKED',
      `this issue is at \`${issue.status}\`, where its criteria are the ones its verdicts were earned on; reopen it to change them, or correct one wording with PATCH /api/issues/:id/criteria/:n, which keeps its verdicts`,
    );
  }
  const match = matchCriteria(live, desired);
  if (match.ambiguous.length > 0) {
    throw refuseCriteria('CRITERIA_RENUMBER_AMBIGUOUS', ambiguousDetail(match.ambiguous), path);
  }
  await refuseDroppedTraces(tx, issue.id, live, desired, path);
  for (const row of match.retired) {
    await tx
      .update(issueCriteria)
      .set({ retiredAt: sql`now()` })
      .where(eq(issueCriteria.id, row.id));
  }
  const parked = Math.max(0, ...live.map((r) => r.n), ...desired.map((c) => c.n)) + 1;
  for (const [i, row] of match.kept) {
    if (row.n === desired[i]?.n) continue;
    await tx
      .update(issueCriteria)
      .set({ n: parked + i })
      .where(eq(issueCriteria.id, row.id));
  }
  for (const [position, c] of desired.entries()) {
    const kept = match.kept.get(position);
    const requirement =
      c.requirementCriterionId === undefined
        ? {}
        : { requirementCriterionId: c.requirementCriterionId };
    if (kept) {
      await tx
        .update(issueCriteria)
        .set({ n: c.n, position, ...requirement })
        .where(eq(issueCriteria.id, kept.id));
      continue;
    }
    await tx.insert(issueCriteria).values({
      issueId: issue.id,
      n: c.n,
      statement: c.statement.trim(),
      position,
      ...requirement,
    });
  }
}

async function refuseDroppedTraces(
  tx: Tx,
  issueId: string,
  live: readonly LiveRow[],
  desired: readonly CriterionInput[],
  path: CriteriaPath,
): Promise<void> {
  const ids = [...live, ...desired].flatMap((c) => c.requirementCriterionId ?? []);
  const dropped = droppedTraces(live, desired, await tracedCodesOf(tx, issueId, [...new Set(ids)]));
  if (dropped.length)
    throw refuseCriteria('CRITERIA_TRACE_DROPPED', droppedTraceDetail(dropped), path);
}

/**
 * The criteria with the trace each one's words state, for every criterion sent without
 * `requirementCriterionId` (the text path sends none): a lead `(REQ-n BC-m)` resolved to the wording
 * of that code live at the revision the issue was planned against (its requirement's current one
 * where it records none). A tag naming another requirement, a code with no live wording, or a lead
 * tag of another shape is refused by name, and so is a tag after the start of the line (ISS-625),
 * which would trace nothing in silence. A criterion kept word for word is not judged again, so a row
 * written before these rules never blocks an unrelated write; the issue-ready checklist names it
 * instead. An untagged criterion states nothing and keeps what it had; one sent with
 * `requirementCriterionId` is traced by that field, and its words are text.
 */
async function tracedInputs(
  tx: Tx,
  issueId: string,
  desired: readonly CriterionInput[],
  path: CriteriaPath,
): Promise<CriterionInput[]> {
  const rows = await liveRows(tx, issueId);
  const { kept: keptRows } = matchCriteria(rows, desired);
  const tags = desired.map((c, i) => ({
    c,
    i,
    tag:
      c.requirementCriterionId === undefined ? traceTagOf(c.statement) : { kind: 'none' as const },
  }));
  for (const { c, i, tag } of tags) {
    if (c.requirementCriterionId !== undefined || keptRows.has(i)) continue;
    if (tag.kind === 'malformed') {
      throw refuseCriteria(
        'CRITERIA_TRACE_INVALID',
        `criterion ${c.n} opens with ${JSON.stringify(tag.tag)}, which is not a trace: write ${TRACE_TAG_SHAPE}, one criterion per BC`,
        path,
      );
    }
    const stray = strayTraceTagsOf(c.statement);
    if (stray.length > 0) {
      throw refuseCriteria(
        'CRITERIA_TRACE_NOT_LEADING',
        `criterion ${c.n} carries ${stray.join(', ')} after the start of its line, where a tag traces nothing: open the line with the one BC it proves, ${TRACE_TAG_SHAPE}, or name it in prose without the parentheses`,
        path,
      );
    }
  }
  if (tags.every((t) => t.tag.kind !== 'tag')) return [...desired];
  const { requirement: req, wordings } = await traceWordingsOf(tx, issueId);
  const revision = req?.revision ?? null;
  const traced = tags.map(({ c, i, tag }) => {
    if (tag.kind !== 'tag') return c;
    const where = `criterion ${c.n} traces REQ-${tag.requirementSeq} ${tag.code}`;
    if (!req) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `${where}, and this issue serves no requirement: link it to REQ-${tag.requirementSeq} first, or drop the tag`,
        path,
      );
    }
    if (req.seq !== tag.requirementSeq) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `${where}, and this issue serves REQ-${req.seq}: a criterion proves a BC of its own issue's requirement`,
        path,
      );
    }
    const live = liveWordingAt(wordings, tag.code, revision);
    if (!live) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `${where}, and REQ-${req.seq} has no wording of ${tag.code} live at revision ${revision ?? 'none'}, the one this issue was planned against`,
        path,
      );
    }
    const kept = keptRows.get(i);
    const keptCode = wordings.find((w) => w.id === kept?.requirementCriterionId)?.code;
    // an unchanged criterion already traced to a wording of this code keeps the wording it has
    if (keptCode === tag.code) return c;
    return { ...c, requirementCriterionId: live.id };
  });
  const taken = traced.flatMap((c, i) =>
    c.requirementCriterionId && c !== desired[i] ? [c.requirementCriterionId] : [],
  );
  const owned = await failureOwnedElsewhere(tx, issueId, taken);
  if (owned) throw refuseCriteria('CRITERION_FAILURE_OWNED', owned, path);
  return traced;
}

/** Refuse a desired set whose numbers repeat or fall below 1, or whose statements are blank. */
function inputFault(desired: readonly CriterionInput[]): string | null {
  const seen = new Set<number>();
  for (const c of desired) {
    if (!Number.isSafeInteger(c.n) || c.n < 1) return `criterion number ${c.n} is not 1 or more`;
    if (seen.has(c.n)) return `criterion ${c.n} is named twice`;
    if (!c.statement.trim()) return `criterion ${c.n} has no statement`;
    seen.add(c.n);
  }
  return null;
}

export async function lockIssue(
  tx: Tx,
  issueId: string,
): Promise<{ id: string; status: string } | null> {
  const [row] = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .for('update');
  return row ?? null;
}

/**
 * The plan step's write: replace the criteria, and render `acceptance_criteria` from them so the
 * text a reader of the plain field reads says the same thing.
 */
export async function putCriteria(
  tx: Tx,
  issueId: string,
  desired: readonly CriterionInput[],
): Promise<boolean> {
  const fault = inputFault(desired);
  if (fault) throw refuseCriteria('CRITERIA_INPUT_INVALID', fault, '/criteria');
  const issue = await lockIssue(tx, issueId);
  if (!issue) return false;
  await applyCriteria(
    tx,
    issue,
    await tracedInputs(tx, issue.id, desired, '/criteria'),
    '/criteria',
  );
  const text = renderCriteriaText(
    desired.map(({ n, statement }) => ({ n, statement: statement.trim() })),
  );
  await tx
    .update(issues)
    .set({ acceptanceCriteria: text === '' ? null : text })
    .where(eq(issues.id, issueId));
  return true;
}

/**
 * cm:hack — the text dual path. forge-plugin 3.36.542 writes criteria as `acceptance_criteria`
 * text, so every write of that text is read into rows here, in the write's own transaction. A text
 * with a repeated or blank number is refused by name rather than half-read. Exit: the plugin's plan
 * step calls `PUT /api/issues/:id/criteria` (plugin-followups.md); then the text is rendered only.
 */
export async function syncCriteriaFromText(
  tx: Tx,
  issueId: string,
  text: string | null,
): Promise<void> {
  const [issue] = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) return;
  const parsed = parseCriteriaText(text);
  if (parsed.faults.length > 0) {
    throw refuseCriteria(
      'CRITERIA_TEXT_UNPARSEABLE',
      `acceptanceCriteria cannot be read as numbered criteria: ${parsed.faults.map((f) => f.why).join('; ')}. Number each criterion once (\`1. …\`, \`2. …\`).`,
      '/acceptanceCriteria',
    );
  }
  await applyCriteria(
    tx,
    issue,
    await tracedInputs(tx, issue.id, parsed.criteria, '/acceptanceCriteria'),
    '/acceptanceCriteria',
  );
}

const LIST_SQL = (issueIds: readonly string[]) => sql`
  SELECT c.issue_id, c.id, c.n, c.statement, c.position, c.requirement_criterion_id,
         v.id AS v_id, v.verdict, v.reason, v.identity_kind, v.commit_sha, v.runtime_ref,
         v.design_workflow_id, w.flow AS design_flow, v.design_revision, v.contract_ref,
         v.contract_version, v.storefront_drafts,
         v.storefront_environment, v.corroboration, v.corroboration_note, v.evidence, v.probe_id, v.author_agency, v.backfilled, v.created_at AS v_created_at
    FROM issue_criteria c
    LEFT JOIN LATERAL (
      SELECT * FROM criterion_verdicts cv
       WHERE cv.criterion_id = c.id
       ORDER BY cv.created_at DESC, cv.id DESC
       LIMIT 1
    ) v ON true
    LEFT JOIN project_workflows w ON w.id = v.design_workflow_id
   WHERE c.issue_id IN (${sql.join(
     issueIds.map((id) => sql`${id}::uuid`),
     sql`, `,
   )}) AND c.retired_at IS NULL
   ORDER BY c.issue_id, c.position, c.n`;

export type ListRow = {
  issue_id: string;
  id: string;
  n: number;
  statement: string;
  position: number;
  requirement_criterion_id: string | null;
  v_id: string | null;
  verdict: VerdictValue | null;
  reason: string | null;
  identity_kind: VerdictIdentityKind | null;
  commit_sha: string | null;
  runtime_ref: string | null;
  design_workflow_id: string | null;
  design_flow: string | null;
  design_revision: number | null;
  contract_ref: string | null;
  contract_version: string | null;
  storefront_drafts: StorefrontDraftPart[] | null;
  storefront_environment: string | null;
  corroboration: VerdictCorroboration | null;
  corroboration_note: string | null;
  evidence: string[] | null;
  probe_id: string | null;
  author_agency: ActorAgency | null;
  backfilled: boolean | null;
  v_created_at: Date | string | null;
};

export function latestOf(row: ListRow): LatestVerdict | null {
  if (row.v_id === null || row.verdict === null) return null;
  return {
    id: row.v_id,
    verdict: row.verdict,
    reason: row.reason,
    identityKind: row.identity_kind,
    commitSha: row.commit_sha,
    runtimeRef: row.runtime_ref,
    designWorkflowId: row.design_workflow_id,
    designFlow: row.design_flow,
    designRevision: row.design_revision,
    contractRef: row.contract_ref,
    contractVersion: row.contract_version,
    storefrontDrafts: row.storefront_drafts,
    storefrontEnvironment: row.storefront_environment,
    corroboration: row.corroboration,
    corroborationNote: row.corroboration_note,
    evidence: row.evidence ?? [],
    probeId: row.probe_id ?? null,
    authorAgency: row.author_agency ?? 'human',
    backfilled: row.backfilled === true,
    createdAt: new Date(row.v_created_at ?? 0).toISOString(),
  };
}

function criterionOf(row: ListRow): CriterionWithVerdict {
  return {
    id: row.id,
    n: row.n,
    statement: row.statement,
    position: row.position,
    requirementCriterionId: row.requirement_criterion_id,
    latest: latestOf(row),
  };
}

/** Every live criterion of an issue, in order, each with its latest verdict or null. */
export async function listCriteria(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<CriterionWithVerdict[]> {
  const rows = (await executor.execute(LIST_SQL([issueId]))) as unknown as ListRow[];
  return [...rows].map(criterionOf);
}

/** A criterion a reword, a removal or a re-tie retired, with every verdict it earned, newest first. */
export interface RetiredCriterion {
  readonly id: string;
  readonly n: number;
  readonly statement: string;
  readonly requirementCriterionId: string | null;
  readonly retiredAt: string;
  readonly verdicts: readonly LatestVerdict[];
}

/**
 * Every retired criterion of an issue, most recently retired first, each with all its verdicts: what
 * an earlier judge found stays readable after the criterion it judged was reworded or tied again.
 * Nothing counts them; the gate and coverage read live criteria only.
 */
export async function listRetiredCriteria(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<RetiredCriterion[]> {
  const rows = (await executor.execute(sql`
    SELECT c.issue_id, c.id, c.n, c.statement, c.position, c.requirement_criterion_id, c.retired_at,
           v.id AS v_id, v.verdict, v.reason, v.identity_kind, v.commit_sha, v.runtime_ref,
           v.design_workflow_id, w.flow AS design_flow, v.design_revision, v.contract_ref,
           v.contract_version, v.storefront_drafts,
           v.storefront_environment, v.corroboration, v.corroboration_note, v.evidence, v.probe_id,
           v.author_agency, v.backfilled, v.created_at AS v_created_at
      FROM issue_criteria c
      LEFT JOIN criterion_verdicts v ON v.criterion_id = c.id
      LEFT JOIN project_workflows w ON w.id = v.design_workflow_id
     WHERE c.issue_id = ${issueId}::uuid AND c.retired_at IS NOT NULL
     ORDER BY c.retired_at DESC, c.n, c.id, v.created_at DESC, v.id DESC`)) as unknown as (ListRow & {
    retired_at: Date | string;
  })[];
  const out = new Map<string, RetiredCriterion & { verdicts: LatestVerdict[] }>();
  for (const row of rows) {
    const held = out.get(row.id) ?? {
      id: row.id,
      n: row.n,
      statement: row.statement,
      requirementCriterionId: row.requirement_criterion_id,
      retiredAt: new Date(row.retired_at).toISOString(),
      verdicts: [],
    };
    const verdict = latestOf(row);
    if (verdict) held.verdicts.push(verdict);
    out.set(row.id, held);
  }
  return [...out.values()];
}

export async function listCriteriaOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, CriterionWithVerdict[]>> {
  const out = new Map<string, CriterionWithVerdict[]>(issueIds.map((id) => [id, []]));
  if (issueIds.length === 0) return out;
  const rows = (await executor.execute(LIST_SQL(issueIds))) as unknown as ListRow[];
  for (const row of rows) out.get(row.issue_id)?.push(criterionOf(row));
  return out;
}
