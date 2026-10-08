/**
 * ISS-55 — reads and writes of `issue_criteria` and `criterion_verdicts`.
 *
 * Criteria are written whole (a plan's PUT, or a write of `acceptance_criteria` text): a criterion
 * whose number and statement are unchanged keeps its row, a reworded one is retired and re-added so
 * the verdicts on the old wording stop counting, and a removed one is retired. Verdicts are only
 * ever inserted; the latest per live criterion is the one the gate and the UI read.
 */

import type { CriteriaRefusalCode } from '@forge/contracts/issues';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { VerdictCorroboration, VerdictDraftReading } from '@forge/contracts/verdict-identity';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import {
  issueCriteria,
  type VerdictIdentityKind,
  type VerdictValue,
} from '../../db/schema-issue-criteria.js';
import { refuser } from '../../lib/refusal.js';
import { liveTracedCodesOf, traceWordingsOf } from '../ports.js';
import {
  normalizeStatement,
  type ParsedCriterion,
  parseCriteriaText,
  renderCriteriaText,
  TRACE_TAG_SHAPE,
  traceTagOf,
} from './criteria-text.js';

const refuseCriteria = refuser<CriteriaRefusalCode>('CRITERIA_REFUSED');

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
  readonly storefrontWorkflowId: string | null;
  readonly storefrontDraftVersion: string | null;
  readonly storefrontEnvironment: string | null;
  readonly corroboration: VerdictDraftReading | null;
  readonly corroborationNote: string | null;
  readonly evidence: readonly string[];
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

type LiveRow = { id: string; n: number; statement: string; requirementCriterionId: string | null };

export async function liveRows(tx: Tx, issueId: string): Promise<LiveRow[]> {
  return tx
    .select({
      id: issueCriteria.id,
      n: issueCriteria.n,
      statement: issueCriteria.statement,
      requirementCriterionId: issueCriteria.requirementCriterionId,
    })
    .from(issueCriteria)
    .where(and(eq(issueCriteria.issueId, issueId), isNull(issueCriteria.retiredAt)));
}

/** Whether a desired set says the same thing as the live rows: same numbers, same statements. */
function unchanged(live: readonly LiveRow[], desired: readonly CriterionInput[]): boolean {
  if (live.length !== desired.length) return false;
  const byN = new Map(live.map((row) => [row.n, normalizeStatement(row.statement)]));
  return desired.every((c) => byN.get(c.n) === normalizeStatement(c.statement));
}

/**
 * Make the issue's live criteria exactly `desired`, in its order. Refused CRITERIA_LOCKED where the
 * set would change at a status whose verdicts were earned on it.
 */
async function applyCriteria(
  tx: Tx,
  issue: { id: string; status: string },
  desired: readonly CriterionInput[],
): Promise<void> {
  const live = await liveRows(tx, issue.id);
  const same = unchanged(live, desired);
  if (!same && LOCKED_STATUSES.has(issue.status)) {
    throw refuseCriteria(
      'CRITERIA_LOCKED',
      `this issue is at \`${issue.status}\`, where its criteria are the ones its verdicts were earned on; reopen it to change them`,
    );
  }
  await refuseDroppedTraces(tx, issue.id, live, desired);
  const keep = new Map<number, string>();
  for (const row of live) {
    const wanted = desired.find((c) => c.n === row.n);
    if (wanted && normalizeStatement(wanted.statement) === normalizeStatement(row.statement)) {
      keep.set(row.n, row.id);
      continue;
    }
    await tx
      .update(issueCriteria)
      .set({ retiredAt: sql`now()` })
      .where(eq(issueCriteria.id, row.id));
  }
  for (const [position, c] of desired.entries()) {
    const kept = keep.get(c.n);
    const requirement =
      c.requirementCriterionId === undefined
        ? {}
        : { requirementCriterionId: c.requirementCriterionId };
    if (kept) {
      await tx
        .update(issueCriteria)
        .set({ position, ...requirement })
        .where(eq(issueCriteria.id, kept));
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

/**
 * The BCs the live rows trace that the desired set would leave untraced, by code: a write that
 * rewords or removes a traced criterion and does not restate the trace drops that BC's proof
 * silently (HOP ISS-39, whose 2026-10-06 rewrite left REQ-25 BC-1, BC-2 and BC-7 with no issue).
 * Where every desired criterion states its trace (`requirementCriterionId` given, `null` meaning
 * none) the writer said so and nothing is refused; a wording the requirement retired, or one of
 * another requirement, counts as no proof to lose.
 */
export function droppedTraceIds(
  live: readonly Pick<LiveRow, 'n' | 'statement' | 'requirementCriterionId'>[],
  desired: readonly CriterionInput[],
): string[] {
  if (desired.every((c) => c.requirementCriterionId !== undefined)) return [];
  const before = new Set(
    live.flatMap((r) => (r.requirementCriterionId ? [r.requirementCriterionId] : [])),
  );
  const after = new Set<string>();
  for (const c of desired) {
    if (c.requirementCriterionId) after.add(c.requirementCriterionId);
    if (c.requirementCriterionId !== undefined) continue;
    const kept = live.find(
      (r) => r.n === c.n && normalizeStatement(r.statement) === normalizeStatement(c.statement),
    );
    if (kept?.requirementCriterionId) after.add(kept.requirementCriterionId);
  }
  return [...before].filter((id) => !after.has(id));
}

async function refuseDroppedTraces(
  tx: Tx,
  issueId: string,
  live: readonly LiveRow[],
  desired: readonly CriterionInput[],
): Promise<void> {
  const dropped = droppedTraceIds(live, desired);
  if (dropped.length === 0) return;
  const codes = await liveTracedCodesOf(tx, issueId, dropped);
  if (codes.length === 0) return;
  throw refuseCriteria(
    'CRITERIA_TRACE_DROPPED',
    `this write leaves ${codes.join(', ')} traced by no criterion of this issue, so the proof it held would vanish silently. Restate each trace — open the criterion that proves it with ${TRACE_TAG_SHAPE}, or send \`requirementCriterionId\` on PUT /criteria — or, to drop it on purpose, PUT the criteria with \`requirementCriterionId\` stated (null for none) on every one`,
    '/acceptanceCriteria',
  );
}

/**
 * The text path's criteria with the trace each states: a lead `(REQ-n BC-m)` resolved to the wording
 * of that code live at the revision the issue was planned against (its requirement's current one
 * where it records none). A tag naming another requirement, a code with no live wording, or a tag of
 * another shape is refused by name; an untagged criterion states nothing and keeps what it had.
 */
async function tracedInputs(
  tx: Tx,
  issueId: string,
  parsed: readonly ParsedCriterion[],
): Promise<CriterionInput[]> {
  const tags = parsed.map((c) => ({ c, tag: traceTagOf(c.statement) }));
  const malformed = tags.find((t) => t.tag.kind === 'malformed');
  if (malformed && malformed.tag.kind === 'malformed') {
    throw refuseCriteria(
      'CRITERIA_TRACE_INVALID',
      `criterion ${malformed.c.n} opens with ${JSON.stringify(malformed.tag.tag)}, which is not a trace: write ${TRACE_TAG_SHAPE}, one criterion per BC`,
      '/acceptanceCriteria',
    );
  }
  if (tags.every((t) => t.tag.kind === 'none')) return [...parsed];
  const { requirement: req, wordings } = await traceWordingsOf(tx, issueId);
  const rows = await liveRows(tx, issueId);
  const revision = req?.revision ?? null;
  return tags.map(({ c, tag }) => {
    if (tag.kind !== 'tag') return c;
    const where = `criterion ${c.n} traces REQ-${tag.requirementSeq} ${tag.code}`;
    if (!req) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `${where}, and this issue serves no requirement: link it to REQ-${tag.requirementSeq} first, or drop the tag`,
        '/acceptanceCriteria',
      );
    }
    if (req.seq !== tag.requirementSeq) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `${where}, and this issue serves REQ-${req.seq}: a criterion proves a BC of its own issue's requirement`,
        '/acceptanceCriteria',
      );
    }
    const live = wordings.filter(
      (w) =>
        w.code === tag.code &&
        revision !== null &&
        w.sinceRevision <= revision &&
        (w.retiredRevision === null || w.retiredRevision > revision),
    );
    if (live.length !== 1 || !live[0]) {
      throw refuseCriteria(
        'CRITERIA_TRACE_UNRESOLVED',
        `${where}, and REQ-${req.seq} has no wording of ${tag.code} live at revision ${revision ?? 'none'}, the one this issue was planned against`,
        '/acceptanceCriteria',
      );
    }
    const kept = rows.find(
      (r) => r.n === c.n && normalizeStatement(r.statement) === normalizeStatement(c.statement),
    );
    const keptCode = wordings.find((w) => w.id === kept?.requirementCriterionId)?.code;
    // an unchanged criterion already traced to a wording of this code keeps the wording it has
    if (keptCode === tag.code) return c;
    return { ...c, requirementCriterionId: live[0].id };
  });
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

async function lockIssue(tx: Tx, issueId: string): Promise<{ id: string; status: string } | null> {
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
  await applyCriteria(tx, issue, desired);
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
  await applyCriteria(tx, issue, await tracedInputs(tx, issue.id, parsed.criteria));
}

const LIST_SQL = (issueIds: readonly string[]) => sql`
  SELECT c.issue_id, c.id, c.n, c.statement, c.position, c.requirement_criterion_id,
         v.id AS v_id, v.verdict, v.reason, v.identity_kind, v.commit_sha, v.runtime_ref,
         v.design_workflow_id, w.flow AS design_flow, v.design_revision, v.contract_ref,
         v.contract_version, v.storefront_workflow_id, v.storefront_draft_version,
         v.storefront_environment, v.corroboration, v.corroboration_note, v.evidence, v.author_agency, v.backfilled, v.created_at AS v_created_at
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

type ListRow = {
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
  storefront_workflow_id: string | null;
  storefront_draft_version: string | null;
  storefront_environment: string | null;
  corroboration: VerdictCorroboration | null;
  corroboration_note: string | null;
  evidence: string[] | null;
  author_agency: ActorAgency | null;
  backfilled: boolean | null;
  v_created_at: Date | string | null;
};

function latestOf(row: ListRow): LatestVerdict | null {
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
    storefrontWorkflowId: row.storefront_workflow_id,
    storefrontDraftVersion: row.storefront_draft_version,
    storefrontEnvironment: row.storefront_environment,
    corroboration: row.corroboration,
    corroborationNote: row.corroboration_note,
    evidence: row.evidence ?? [],
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
