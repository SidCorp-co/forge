/**
 * The patterns an issue names (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`): the store,
 * the dispatch gate every door asks, and the writes. A catalogued pattern is reuse and records no
 * approval; an uncatalogued one is new and holds its issue until one reviewer decides it.
 *
 * One predicate (`db/schema-issue-patterns.ts:patternReviewPendingSql`), asked the ways the contract
 * wait is (`issues/contract-waits.ts`): the admissible list leaves a held issue out, a run session,
 * a pool job or a move to in_progress over it is refused by name (PATTERN_REVIEW_PENDING), and a
 * queued job names it as its dispatch gate. A returned pattern no later one answers holds the work
 * out of build and the issue out of awaiting_release (PATTERN_RETURNED), and its reason is posted on
 * the issue. The rules are `pattern-rules.ts`, the run a call is `pattern-runs.ts`, and the catalog
 * entry the merge mark asks for `pattern-entry.ts`.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import {
  type IssuePatterns,
  type IssuePatternView,
  PATTERN_RETURNED,
  PATTERN_REVIEW_PENDING,
  type PatternCatalogStanding,
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
import { emitEvents } from '../outbox/index.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { issueDisplayIds } from './display-ids.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  type CatalogReading,
  catalogReadingOf,
  decideRefusals,
  nameOutcome,
  type PatternDecider,
  type PatternRowFacts,
  pendingDetail,
  releaseFaults,
  retractRefusals,
  returnedDetail,
  unansweredReturns,
} from './pattern-rules.js';
import { liveOnBox, runOfCall } from './pattern-runs.js';
import { type GateReader, postIssueNotice, readProjectDocument } from './ports.js';

export { patternReviewPendingSql };

export type IssuePatternRow = typeof issuePatterns.$inferSelect;

type Outcome<T> = { ok: true; value: T } | { ok: false; refusals: PatternRefusal[] };

/** The catalog `projectId` reads, from the repository its project document declares. */
export async function catalogOf(projectId: string): Promise<CatalogReading> {
  const document = (await readProjectDocument(projectId))?.document;
  return catalogReadingOf(document?.source.git?.repository ?? null);
}

/** Whether the project reads a catalog, for the read a run asks before it names a pattern. */
function catalogStanding(catalog: CatalogReading): PatternCatalogStanding {
  return catalog.kind === 'read'
    ? { declared: true, detail: null }
    : { declared: false, detail: catalog.detail };
}

const factsOf = (r: IssuePatternRow): PatternRowFacts => ({
  id: r.id,
  pattern: r.pattern,
  kind: r.kind,
  namedBy: r.namedBy,
  namedSession: r.namedSessionId,
  createdAt: r.createdAt,
  decision: r.decision,
  decidedAt: r.decidedAt,
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

export function patternView(
  r: IssuePatternRow,
  issue: string,
  unanswered: ReadonlySet<string> = new Set(),
): IssuePatternView {
  return {
    id: r.id,
    issue,
    pattern: r.pattern,
    kind: r.kind,
    summary: r.summary,
    namedBy: r.namedBy,
    namedSession: r.namedSessionId,
    namedAt: r.createdAt.toISOString(),
    decision: r.decision,
    decidedBy: r.decidedBy,
    decidedSession: r.decidedSessionId,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason,
    retractedAt: r.retractedAt?.toISOString() ?? null,
    retractReason: r.retractReason,
    pending: r.kind === 'new' && r.decision === null && r.retractedAt === null,
    unanswered: unanswered.has(r.id),
  };
}

/** The rows as the REST answers show them; `siblings` are the issue's rows, which say what a return is answered by. */
export async function patternViews(
  rows: readonly IssuePatternRow[],
  siblings: readonly IssuePatternRow[] = rows,
): Promise<IssuePatternView[]> {
  const refs = await issueDisplayIds([...new Set(rows.map((r) => r.issueId))]);
  const unanswered = new Set(unansweredReturns(siblings.map(factsOf)).map((r) => r.id));
  return rows.map((r) => patternView(r, refs.get(r.issueId) ?? r.issueId, unanswered));
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

export interface PatternActor {
  userId: string;
  agency: ActorAgency | null;
  /** The device a box credential belongs to; null on a person's. */
  box: string | null;
  /** The run the call names (`run`), on a box credential. */
  run?: string | undefined;
}

/** The issue's unanswered return, in the refusal the build step and awaiting_release give, or null. */
function returnHold(
  issueRef: string,
  rows: readonly PatternRowFacts[],
): { code: typeof PATTERN_RETURNED; detail: string } | null {
  const returned = unansweredReturns(rows).map((r) => r.pattern);
  return returned.length === 0
    ? null
    : { code: PATTERN_RETURNED, detail: returnedDetail(issueRef, returned) };
}

/** The pending rows `caller` may decide now; none where it holds no patterns.approve or cannot be told apart. */
async function decidableBy(
  issue: { id: string; projectId: string },
  rows: readonly PatternRowFacts[],
  caller: PatternActor | null,
): Promise<string[]> {
  const pending = rows.filter((r) => r.kind === 'new' && r.decision === null && !r.retractedAt);
  if (!caller || pending.length === 0) return [];
  if (!(await can(actorFor(caller.userId), 'patterns.approve', projectResource(issue.projectId)))) {
    return [];
  }
  const run = await runOfCall({ projectId: issue.projectId, issueId: issue.id, ...caller });
  if (!run.ok) return [];
  const out: string[] = [];
  for (const row of pending) {
    const decider = await deciderOf(caller.userId, run.value, row);
    if (decideRefusals('', row, decider).length === 0) out.push(row.id);
  }
  return out;
}

/**
 * The issue read's answer: whether the project reads a catalog, the issue's patterns, whether a
 * pending review holds it (and the refusal a door would give), an unanswered return, and the pending
 * patterns `caller` may decide.
 */
export async function issuePatternsOf(
  projectId: string,
  issueId: string,
  caller: PatternActor | null = null,
): Promise<IssuePatterns> {
  const rows = await patternRowsOf([issueId]);
  const facts = rows.map(factsOf);
  const held = detailsByIssue(await heldWhere(projectId, sql`i.id = ${issueId}`)).get(issueId);
  const issueRef = (await issueDisplayIds([issueId])).get(issueId) ?? issueId;
  return {
    catalog: catalogStanding(await catalogOf(projectId)),
    patterns: await patternViews(rows),
    dispatchable: held === undefined,
    refusal: held === undefined ? null : { code: PATTERN_REVIEW_PENDING, detail: held },
    returned: returnHold(issueRef, facts),
    decidable: await decidableBy({ id: issueId, projectId }, facts, caller),
  };
}

/** Refuses the work step's move to build while a return stands unanswered (PATTERN_RETURNED). */
export async function assertNoUnansweredReturn(
  issueId: string,
  executor: Pick<Tx, 'select'>,
): Promise<void> {
  const rows = await patternFactsIn(executor, issueId);
  if (rows.length === 0) return;
  const issueRef = (await issueDisplayIds([issueId], executor as Tx)).get(issueId) ?? issueId;
  const hold = returnHold(issueRef, rows);
  if (hold) {
    throw new RefusalError(
      [{ code: hold.code, path: '/workState/step', detail: hold.detail }],
      hold.code,
    );
  }
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
  const run = await runOfCall({ projectId: issue.projectId, issueId: issue.id, ...actor });
  if (!run.ok) return run;
  if (run.value.box !== null && run.value.session === null) {
    return {
      ok: false,
      refusals: [
        {
          code: 'PATTERN_RUN_UNNAMED',
          path: '/run',
          detail: `this call comes from a box that holds no run over the issue, and a box's runs share one credential, so the run naming the pattern cannot be told: send \`run\`, the run id this box declared for it, or name it as a person`,
        },
      ],
    };
  }
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
        namedSessionId: run.value.session,
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

/** Who asks to decide `row`: the account, and on a box the run it is and whether the naming run is live there. */
async function deciderOf(
  userId: string,
  run: { box: string | null; session: string | null },
  row: PatternRowFacts,
): Promise<PatternDecider> {
  const namerLiveHere =
    run.box !== null && row.namedSession !== null
      ? await liveOnBox(row.namedSession, run.box)
      : false;
  return { userId, box: run.box, session: run.session, namerLiveHere };
}

/** The return's reason, posted on the issue for the run that answers it (Issue lifecycle r14). */
async function postReturn(tx: Tx, row: IssuePatternRow, actor: PatternActor, reason: string) {
  const body = `Pattern \`${row.pattern}\` was returned by its reviewer: ${reason}\n\nUntil this issue names a catalogued pattern instead, or names \`${row.pattern}\` again with a revised summary for a new review, its work does not move to build and it does not move to awaiting_release (PATTERN_RETURNED).`;
  const notice = await postIssueNotice({ issueId: row.issueId, authorId: actor.userId, body }, tx);
  await emitEvents(tx, [
    {
      type: 'comment.created',
      payload: {
        issueId: row.issueId,
        projectId: row.projectId,
        actor: { type: 'user', id: actor.userId, agency: actor.agency ?? 'human' },
        authored: actor.agency ?? 'human',
        commentId: notice.id,
        body: notice.body,
        parentId: notice.parentId,
      },
    },
  ]);
}

/**
 * One reviewer's decision on a new pattern. The route has asked for patterns.approve; the rule
 * here refuses the run that named it, or the person who did. A return posts its reason on the issue.
 * Null when the issue holds no such pattern.
 */
export async function decidePattern(args: {
  issueId: string;
  projectId: string;
  patternId: string;
  decision: PatternDecision;
  reason: string;
  actor: PatternActor;
}): Promise<Outcome<IssuePatternRow> | null> {
  const { actor } = args;
  const run = await runOfCall({ projectId: args.projectId, issueId: args.issueId, ...actor });
  if (!run.ok) return run;
  return db.transaction(async (tx) => {
    const row = await lockedRow(tx, args.issueId, args.patternId);
    if (!row) return null;
    const decider = await deciderOf(actor.userId, run.value, factsOf(row));
    const refusals = decideRefusals(await issueRefOf(args.issueId, tx), factsOf(row), decider);
    if (refusals.length > 0) return { ok: false as const, refusals };
    const [decided] = await tx
      .update(issuePatterns)
      .set({
        decision: args.decision,
        decidedBy: actor.userId,
        decidedAgency: actor.agency,
        decidedSessionId: run.value.session,
        decidedAt: new Date(),
        decisionReason: args.reason,
      })
      .where(and(eq(issuePatterns.id, row.id), isNull(issuePatterns.decision)))
      .returning();
    if (!decided) throw new Error(`pattern ${row.id} was decided under its own lock`);
    if (args.decision === 'returned') await postReturn(tx, decided, actor, args.reason);
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
 * What the move to awaiting_release (and to closed) asks of the issue's patterns under its lock: no
 * new pattern waits on its reviewer, and no return stands unanswered (`pattern-rules.ts:releaseFaults`).
 * The catalog entry is the merge mark's to ask (`pattern-entry.ts`). The first fault, or null.
 */
export async function patternReleaseRefusal(
  executor: Pick<Tx, 'select'>,
  issueId: string,
): Promise<Refusal | null> {
  const rows = await patternFactsIn(executor, issueId);
  if (rows.length === 0) return null;
  const issueRef = (await issueDisplayIds([issueId], executor as Tx)).get(issueId) ?? issueId;
  const [fault] = releaseFaults(issueRef, rows);
  return fault ? { code: fault.code, path: '/status', detail: fault.detail } : null;
}
