/**
 * The patterns an issue names (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`): the store,
 * the dispatch gate every door asks, and the writes. A catalogued pattern is reuse and records no
 * approval; an uncatalogued one is new and holds its issue until one reviewer decides it.
 *
 * One predicate (`db/schema-issue-patterns.ts:patternReviewPendingSql`), asked the ways the contract
 * wait is (`issues/contract-waits.ts`): the admissible list leaves a held issue out, a run session,
 * a pool job or a move to in_progress over it is refused by name (PATTERN_REVIEW_PENDING), and a
 * queued job names it as its dispatch gate. The rules are `pattern-rules.ts`.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import {
  type IssuePatterns,
  type IssuePatternView,
  PATTERN_REVIEW_PENDING,
  type PatternDecision,
  type PatternRefusal,
} from '@forge/contracts/patterns';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { idList } from '../db/raw-sql.js';
import { issuePatterns, patternReviewPendingSql } from '../db/schema-issue-patterns.js';
import { lockXact } from '../lib/advisory-lock.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { issueDisplayIds } from './display-ids.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  type CatalogReading,
  catalogReadingOf,
  decideRefusals,
  nameOutcome,
  type PatternRowFacts,
  pendingDetail,
  releaseFaults,
  retractRefusals,
} from './pattern-rules.js';
import { type GateReader, readProjectDocument } from './ports.js';

export { patternReviewPendingSql };

export type IssuePatternRow = typeof issuePatterns.$inferSelect;

type Outcome<T> = { ok: true; value: T } | { ok: false; refusals: PatternRefusal[] };

/** The catalog `projectId` reads, from the repository its project document declares. */
export async function catalogOf(projectId: string): Promise<CatalogReading> {
  const document = (await readProjectDocument(projectId))?.document;
  return catalogReadingOf(document?.source.git?.repository ?? null);
}

const factsOf = (r: IssuePatternRow): PatternRowFacts => ({
  id: r.id,
  pattern: r.pattern,
  kind: r.kind,
  namedBy: r.namedBy,
  decision: r.decision,
  retractedAt: r.retractedAt,
});

export async function patternRowsOf(
  issueIds: readonly string[],
  executor: Pick<Tx, 'select'> = db,
): Promise<IssuePatternRow[]> {
  if (issueIds.length === 0) return [];
  return executor
    .select()
    .from(issuePatterns)
    .where(inArray(issuePatterns.issueId, [...issueIds]))
    .orderBy(issuePatterns.createdAt);
}

export function patternView(r: IssuePatternRow, issue: string): IssuePatternView {
  return {
    id: r.id,
    issue,
    pattern: r.pattern,
    kind: r.kind,
    summary: r.summary,
    namedBy: r.namedBy,
    namedAt: r.createdAt.toISOString(),
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason,
    retractedAt: r.retractedAt?.toISOString() ?? null,
    retractReason: r.retractReason,
    pending: r.kind === 'new' && r.decision === null && r.retractedAt === null,
  };
}

export async function patternViews(rows: readonly IssuePatternRow[]): Promise<IssuePatternView[]> {
  const refs = await issueDisplayIds([...new Set(rows.map((r) => r.issueId))]);
  return rows.map((r) => patternView(r, refs.get(r.issueId) ?? r.issueId));
}

interface PendingReview {
  issueId: string;
  issue: string;
  pattern: string;
}

async function heldWhere(
  projectId: string,
  filter: SQL,
  executor: GateReader = db,
): Promise<PendingReview[]> {
  const rows = (await executor.execute(sql`
    SELECT i.id AS issue_id, i.iss_seq, ip.pattern
    FROM issue_patterns ip
    JOIN issues i ON i.id = ip.issue_id
    WHERE ip.project_id = ${projectId}
      AND ip.kind = 'new'
      AND ip.decision IS NULL
      AND ip.retracted_at IS NULL
      AND ${filter}
    ORDER BY i.iss_seq, ip.created_at
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const prefix = await activeIssuePrefix(projectId, executor);
  return rows.map((r) => ({
    issueId: String(r.issue_id),
    issue: formatIssueRef(prefix, Number(r.iss_seq)),
    pattern: String(r.pattern),
  }));
}

/** The pending reviews by issue, each as the sentence a dispatch door refuses it with. */
function detailsByIssue(held: readonly PendingReview[]): Map<string, string> {
  const by = new Map<string, { issue: string; patterns: string[] }>();
  for (const h of held) {
    const at = by.get(h.issueId) ?? { issue: h.issue, patterns: [] };
    at.patterns.push(h.pattern);
    by.set(h.issueId, at);
  }
  return new Map([...by].map(([id, v]) => [id, pendingDetail(v.issue, v.patterns)]));
}

/** The dispatch doors' refusal, one per held issue, in the envelope every door answers with. */
export function patternReviewPending(held: readonly PendingReview[]): RefusalError {
  return new RefusalError(
    [...detailsByIssue(held).values()].map((detail) => ({
      code: PATTERN_REVIEW_PENDING,
      path: '',
      detail,
    })),
    PATTERN_REVIEW_PENDING,
  );
}

/** Why the gate holds each of these issues, by issue id, every issue read in one query. */
export async function patternHoldsOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  return detailsByIssue(await heldWhere(projectId, sql`i.id IN (${idList(issueIds)})`));
}

function refuseHeld(held: PendingReview[]): void {
  if (held.length > 0) throw patternReviewPending(held);
}

/** Refuses a run over these issues (by sequence number) while any holds a new pattern awaiting its reviewer. */
export async function assertPatternReviewsSettledForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  if (seqs.length === 0) return;
  const list = sql.join(
    seqs.map((n) => sql`${n}`),
    sql`, `,
  );
  refuseHeld(await heldWhere(projectId, sql`i.iss_seq IN (${list})`));
}

export async function assertPatternReviewsSettledForIssue(
  projectId: string,
  issueId: string,
  executor: GateReader = db,
): Promise<void> {
  refuseHeld(await heldWhere(projectId, sql`i.id = ${issueId}`, executor));
}

/** The issue read's answer: its patterns, whether a pending review holds it, and the refusal a door would give. */
export async function issuePatternsOf(projectId: string, issueId: string): Promise<IssuePatterns> {
  const rows = await patternRowsOf([issueId]);
  const held = detailsByIssue(await heldWhere(projectId, sql`i.id = ${issueId}`)).get(issueId);
  return {
    patterns: await patternViews(rows),
    dispatchable: held === undefined,
    refusal: held === undefined ? null : { code: PATTERN_REVIEW_PENDING, detail: held },
  };
}

export interface PatternActor {
  userId: string;
  agency: ActorAgency | null;
}

interface IssueScope {
  id: string;
  projectId: string;
  status: string;
}

async function issueRefOf(issueId: string, executor: Tx): Promise<string> {
  return (await issueDisplayIds([issueId], executor)).get(issueId) ?? issueId;
}

/** Names `pattern` on the issue: a catalogued one as reuse, an uncatalogued one as new and pending. */
export async function namePattern(args: {
  issue: IssueScope;
  pattern: string;
  summary: string | null;
  actor: PatternActor;
}): Promise<Outcome<IssuePatternRow>> {
  const { issue, pattern, actor } = args;
  const catalog = await catalogOf(issue.projectId);
  return db.transaction(async (tx) => {
    await lockXact(tx, 'issuePatterns', issue.id);
    const live = await tx
      .select()
      .from(issuePatterns)
      .where(and(eq(issuePatterns.issueId, issue.id), eq(issuePatterns.pattern, pattern)));
    const outcome = nameOutcome({
      issueRef: await issueRefOf(issue.id, tx),
      terminal: (ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status),
      catalog,
      pattern,
      summary: args.summary,
      live: live.map(factsOf),
    });
    if (!outcome.ok) return outcome;
    const [row] = await tx
      .insert(issuePatterns)
      .values({
        projectId: issue.projectId,
        issueId: issue.id,
        pattern,
        kind: outcome.kind,
        summary: args.summary,
        namedBy: actor.userId,
        namedAgency: actor.agency,
      })
      .returning();
    if (!row) throw new Error(`pattern ${pattern} was not named on ${issue.id}`);
    return { ok: true as const, value: row };
  });
}

async function lockedRow(tx: Tx, issueId: string, patternId: string) {
  await lockXact(tx, 'issuePatterns', issueId);
  const [row] = await tx
    .select()
    .from(issuePatterns)
    .where(and(eq(issuePatterns.id, patternId), eq(issuePatterns.issueId, issueId)))
    .limit(1);
  return row ?? null;
}

/**
 * One reviewer's decision on a new pattern. The route has asked for patterns.approve; the rule
 * here refuses the account that named it. Null when the issue holds no such pattern.
 */
export async function decidePattern(args: {
  issueId: string;
  patternId: string;
  decision: PatternDecision;
  reason: string;
  actor: PatternActor;
}): Promise<Outcome<IssuePatternRow> | null> {
  const { actor } = args;
  return db.transaction(async (tx) => {
    const row = await lockedRow(tx, args.issueId, args.patternId);
    if (!row) return null;
    const refusals = decideRefusals(await issueRefOf(args.issueId, tx), factsOf(row), actor.userId);
    if (refusals.length > 0) return { ok: false as const, refusals };
    const [decided] = await tx
      .update(issuePatterns)
      .set({
        decision: args.decision,
        decidedBy: actor.userId,
        decidedAgency: actor.agency,
        decidedAt: new Date(),
        decisionReason: args.reason,
      })
      .where(and(eq(issuePatterns.id, row.id), isNull(issuePatterns.decision)))
      .returning();
    if (!decided) throw new Error(`pattern ${row.id} was decided under its own lock`);
    return { ok: true as const, value: decided };
  });
}

/** The issue no longer takes this pattern; the row stays, and a pending one stops holding the issue. */
export async function retractPattern(args: {
  issueId: string;
  patternId: string;
  reason: string;
  userId: string;
}): Promise<Outcome<IssuePatternRow> | null> {
  return db.transaction(async (tx) => {
    const row = await lockedRow(tx, args.issueId, args.patternId);
    if (!row) return null;
    const refusals = retractRefusals(await issueRefOf(args.issueId, tx), factsOf(row));
    if (refusals.length > 0) return { ok: false as const, refusals };
    const [retracted] = await tx
      .update(issuePatterns)
      .set({ retractedAt: new Date(), retractedBy: args.userId, retractReason: args.reason })
      .where(and(eq(issuePatterns.id, row.id), isNull(issuePatterns.retractedAt)))
      .returning();
    if (!retracted) throw new Error(`pattern ${row.id} was retracted under its own lock`);
    return { ok: true as const, value: retracted };
  });
}

/** The issue's rows as the rules read them, through the move's own transaction. */
export async function patternFactsIn(
  executor: Pick<Tx, 'select'>,
  issueId: string,
): Promise<PatternRowFacts[]> {
  return (await patternRowsOf([issueId], executor)).map(factsOf);
}

/**
 * The merge's half of the pattern rule, asked by the move to awaiting_release (and to closed) under
 * its lock: no new pattern waits on its reviewer, and every approved one has its catalog entry
 * (`pattern-rules.ts:releaseFaults`). The first fault, or null.
 */
export async function patternReleaseRefusal(
  executor: Pick<Tx, 'select'>,
  issueId: string,
  catalog: CatalogReading,
): Promise<Refusal | null> {
  const rows = await patternFactsIn(executor, issueId);
  if (rows.length === 0) return null;
  const issueRef = (await issueDisplayIds([issueId], executor as Tx)).get(issueId) ?? issueId;
  const [fault] = releaseFaults(issueRef, rows, catalog);
  return fault ? { code: fault.code, path: '/status', detail: fault.detail } : null;
}
