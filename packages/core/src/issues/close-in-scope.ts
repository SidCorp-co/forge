// An issue closes when its criteria are met in scope (ADR 0014; owner, 2026-11-07: close an issue
// once it is met in scope, and move whatever was not done elsewhere so nothing is lost). The run
// holding it closes it from `awaiting_release`, its merge recorded, once each criterion it did not meet
// is moved out on the record: to an issue the next batch works, a new issue filed for it, or the
// requirement it serves. The close names where each one went, and one left with no destination is
// refused by name (CLOSE_CRITERION_UNPLACED): silent loss is the one thing ruled out.
//
// A criterion stands unmet where the closer names it in `unmet`, or where its newest verdict is a
// fail. Moving one retires it on the closing issue, recording where it went
// (`issue_criteria.moved_to_criterion_id`, `moved_to_requirement_id`), and appends it, trace and all,
// to the destination issue, whose criteria text is rendered again from its rows. The requirement holds
// one through the BC it traces, which stands with no live criterion proving it once this one retires.
// Whether the work is live is not this close's to say: the release record says it.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { issueCriteria } from '../db/schema-issue-criteria.js';
import { readAdoptionDelivery } from './adoption-delivery.js';
import { renderCriteriaText } from './criteria/criteria-text.js';
import { listCriteria } from './criteria/store.js';
import { designShortfall, readDesignDelivery } from './design-delivered-guard.js';
import { issueDisplayIds } from './display-ids.js';
import { issueIdOfKey } from './issue-route-ref.js';
import { postIssueNotice } from './ports.js';
import type { GuardContext, GuardFault } from './transition-guards.js';

/** One criterion the closer says it did not meet, and where it goes, as the transition body sends it. */
export interface UnmetInput {
  criterion: number;
  to?: { issue: string } | 'requirement' | undefined;
}

/** A destination issue as read before the move's lock: the key the closer sent, and what it names. */
interface NamedIssue {
  sent: string;
  issue: {
    id: string;
    key: string;
    status: IssueStatus;
    requirementId: string | null;
  } | null;
}

/** What the close reads before its lock: each `unmet` entry, its destination issue resolved. */
export interface CloseScopeFacts {
  unmet: readonly UnmetInput[];
  issues: ReadonlyMap<string, NamedIssue>;
}

/** One criterion moved out by the close: where it went, as the close names it. */
export interface MovedCriterion {
  criterionId: string;
  n: number;
  statement: string;
  requirementCriterionId: string | null;
  to:
    | { kind: 'issue'; issueId: string; key: string }
    | { kind: 'requirement'; requirementId: string; label: string };
}

/** Where a criterion's destination is refused: its statuses hold the criteria their verdicts were earned on. */
// status-tuple: differs — these hold criteria fixed by earned verdicts; ISSUE_DISPATCH_TERMINAL_STATUSES says where a dispatch ends, and may grow a status that still takes criteria
const FROZEN: ReadonlySet<IssueStatus> = new Set(['awaiting_release', 'closed', 'dropped']);

/** The three places a criterion the issue did not meet may go, as every refusal names them. */
export const UNMET_DESTINATIONS =
  'an issue the next batch works (`{"criterion":<n>,"to":{"issue":"<its key>"}}`), a new issue filed for it first and named the same way, or the requirement the issue serves (`{"criterion":<n>,"to":"requirement"}`), which holds it through the BC it traces';

/** The destination issues `unmet` names, read before the lock, by key or uuid in the issue's project. */
export async function readCloseScopeFacts(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  unmet: readonly UnmetInput[],
): Promise<CloseScopeFacts> {
  const named = new Map<string, NamedIssue>();
  for (const entry of unmet) {
    const to = entry.to;
    if (!to || to === 'requirement' || named.has(to.issue)) continue;
    const id = await issueIdOfKey(to.issue, projectId);
    if (!id) {
      named.set(to.issue, { sent: to.issue, issue: null });
      continue;
    }
    const rows = (await executor.execute(sql`
      SELECT id, status, requirement_id, project_id FROM issues WHERE id = ${id}::uuid`)) as unknown as Array<{
      id: string;
      status: IssueStatus;
      requirement_id: string | null;
      project_id: string;
    }>;
    const row = rows[0];
    const key = row ? ((await issueDisplayIds([row.id])).get(row.id) ?? row.id) : to.issue;
    named.set(to.issue, {
      sent: to.issue,
      issue:
        row && row.project_id === projectId
          ? { id: row.id, key, status: row.status, requirementId: row.requirement_id }
          : null,
    });
  }
  return { unmet, issues: named };
}

interface Unplaced {
  criterion: number;
  why: string;
}

/**
 * The criteria a close would leave with nowhere to go, each with why, or the moves it makes where
 * none is left. Read under the move's lock, on its transaction.
 */
export async function closeScopeOf(
  executor: Pick<Tx, 'execute'>,
  issue: { id: string },
  facts: CloseScopeFacts,
): Promise<{ unplaced: Unplaced[]; moves: MovedCriterion[] }> {
  const live = await listCriteria(executor, issue.id);
  const byN = new Map(live.map((c) => [c.n, c]));
  const [own] = (await executor.execute(sql`
    SELECT i.requirement_id, r.req_seq FROM issues i
      LEFT JOIN requirements r ON r.id = i.requirement_id
     WHERE i.id = ${issue.id}::uuid`)) as unknown as Array<{
    requirement_id: string | null;
    req_seq: number | null;
  }>;
  const traced = await bcCodesOf(
    executor,
    live.flatMap((c) => (c.requirementCriterionId ? [c.requirementCriterionId] : [])),
  );
  const unplaced: Unplaced[] = [];
  const moves: MovedCriterion[] = [];
  const named = new Set<number>();
  for (const entry of facts.unmet) {
    named.add(entry.criterion);
    const c = byN.get(entry.criterion);
    if (!c) {
      unplaced.push({
        criterion: entry.criterion,
        why: `it is not a live criterion of this issue (its live criteria are ${live.map((l) => l.n).join(', ') || 'none'})`,
      });
      continue;
    }
    const bc = c.requirementCriterionId ? traced.get(c.requirementCriterionId) : undefined;
    const base = {
      criterionId: c.id,
      n: c.n,
      statement: c.statement,
      requirementCriterionId: c.requirementCriterionId,
    };
    const to = entry.to;
    if (!to) {
      unplaced.push({ criterion: c.n, why: 'it names no destination' });
      continue;
    }
    if (to === 'requirement') {
      if (!own?.requirement_id) {
        unplaced.push({ criterion: c.n, why: 'this issue serves no requirement to hold it' });
      } else if (!bc || bc.requirementId !== own.requirement_id) {
        unplaced.push({
          criterion: c.n,
          why: `it traces no BC of REQ-${own.req_seq}, and the requirement holds a criterion only through the BC it traces`,
        });
      } else {
        moves.push({
          ...base,
          to: {
            kind: 'requirement',
            requirementId: own.requirement_id,
            label: `REQ-${bc.reqSeq} ${bc.code}`,
          },
        });
      }
      continue;
    }
    const dest = facts.issues.get(to.issue)?.issue ?? null;
    const fault = !dest
      ? `\`${to.issue}\` names no issue of this project`
      : dest.id === issue.id
        ? 'it names this issue, which is closing'
        : FROZEN.has(dest.status)
          ? `${dest.key} is \`${dest.status}\`, where its criteria are the ones its verdicts were earned on`
          : bc && bc.requirementId !== dest.requirementId
            ? `it traces REQ-${bc.reqSeq} ${bc.code}, and ${dest.key} serves ${dest.requirementId ? 'another requirement' : 'none'}: a criterion proves a BC of its own issue's requirement`
            : null;
    if (fault || !dest) {
      unplaced.push({ criterion: c.n, why: fault ?? 'its destination was not read' });
      continue;
    }
    moves.push({ ...base, to: { kind: 'issue', issueId: dest.id, key: dest.key } });
  }
  for (const c of live) {
    if (named.has(c.n) || c.latest?.verdict !== 'fail') continue;
    unplaced.push({
      criterion: c.n,
      why: 'its newest verdict is a fail, and the close names no destination for it',
    });
  }
  return { unplaced: unplaced.sort((a, b) => a.criterion - b.criterion), moves };
}

/** The refusal of a close leaving criteria with nowhere to go: each named, and the three destinations. */
export function unplacedDetail(unplaced: readonly Unplaced[]): string {
  const each = unplaced.map((u) => `criterion ${u.criterion}: ${u.why}`).join('; ');
  return `an issue closes when its criteria are met in scope, and each one it did not meet is moved out on the record first, so none is lost. This close leaves ${unplaced.length === 1 ? 'a criterion' : `${unplaced.length} criteria`} with nowhere to go (${each}). Name a destination for each in \`unmet\` on the move: ${UNMET_DESTINATIONS}.`;
}

async function bcCodesOf(
  executor: Pick<Tx, 'execute'>,
  ids: readonly string[],
): Promise<Map<string, { requirementId: string; reqSeq: number; code: string }>> {
  if (ids.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT rc.id, rc.requirement_id, rc.code, r.req_seq
      FROM requirement_criteria rc JOIN requirements r ON r.id = rc.requirement_id
     WHERE rc.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})`)) as unknown as Array<{
    id: string;
    requirement_id: string;
    code: string;
    req_seq: number;
  }>;
  return new Map(
    [...rows].map((r) => [
      r.id,
      { requirementId: r.requirement_id, reqSeq: r.req_seq, code: r.code },
    ]),
  );
}

/**
 * Each move the close's guard settled, written in the close's transaction: the criterion appended to
 * its destination issue with its trace, that issue's criteria text rendered again, and the criterion
 * retired here naming where it went. Answers the sentence the close's notice names them in.
 */
export async function moveUnmetCriteria(
  tx: Tx,
  moves: readonly MovedCriterion[],
): Promise<{ sentences: string[]; landed: Array<{ issueId: string; n: number; from: number }> }> {
  const sentences: string[] = [];
  const landed: Array<{ issueId: string; n: number; from: number }> = [];
  for (const move of moves) {
    if (move.to.kind === 'requirement') {
      await tx.execute(sql`
        UPDATE issue_criteria SET retired_at = now(), moved_to_requirement_id = ${move.to.requirementId}::uuid
         WHERE id = ${move.criterionId}::uuid`);
      sentences.push(`criterion ${move.n} → ${move.to.label}, which holds it`);
      continue;
    }
    const destId = move.to.issueId;
    await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${destId}::uuid FOR UPDATE`);
    const [top] = (await tx.execute(sql`
      SELECT coalesce(max(n), 0) AS n, coalesce(max(position), -1) AS position
        FROM issue_criteria WHERE issue_id = ${destId}::uuid AND retired_at IS NULL`)) as unknown as Array<{
      n: number;
      position: number;
    }>;
    const n = Number(top?.n ?? 0) + 1;
    const [added] = await tx
      .insert(issueCriteria)
      .values({
        issueId: destId,
        n,
        statement: move.statement,
        position: Number(top?.position ?? -1) + 1,
        requirementCriterionId: move.requirementCriterionId,
      })
      .returning({ id: issueCriteria.id });
    await tx.execute(sql`
      UPDATE issue_criteria SET retired_at = now(), moved_to_criterion_id = ${added?.id ?? null}::uuid
       WHERE id = ${move.criterionId}::uuid`);
    const rows = (await tx.execute(sql`
      SELECT n, statement FROM issue_criteria
       WHERE issue_id = ${destId}::uuid AND retired_at IS NULL ORDER BY position, n`)) as unknown as Array<{
      n: number;
      statement: string;
    }>;
    await tx
      .update(issues)
      .set({ acceptanceCriteria: renderCriteriaText([...rows]) })
      .where(sql`${issues.id} = ${destId}::uuid`);
    sentences.push(`criterion ${move.n} → ${move.to.key} criterion ${n}`);
    landed.push({ issueId: destId, n, from: move.n });
  }
  return { sentences, landed };
}

/**
 * The close's moves written, and named: on the closed issue, where each criterion it did not meet
 * went, and on each issue that took one on, where it came from. Answers the closed issue's sentences.
 */
export async function postMovedOut(
  tx: Tx,
  issueId: string,
  by: string,
  moves: readonly MovedCriterion[],
): Promise<string[]> {
  const { sentences, landed } = await moveUnmetCriteria(tx, moves);
  const keys = await issueDisplayIds([issueId], tx);
  const from = keys.get(issueId) ?? issueId;
  await postIssueNotice(
    {
      issueId,
      authorId: by,
      body: `Closed met in scope. Each criterion it did not meet was moved out first: ${sentences.join('; ')}.`,
    },
    tx,
  );
  for (const l of landed) {
    await postIssueNotice(
      {
        issueId: l.issueId,
        authorId: by,
        body: `Criterion ${l.n} came from ${from} criterion ${l.from}, which closed without meeting it.`,
      },
      tx,
    );
  }
  return sentences;
}

/**
 * closed from awaiting_release, met in scope: a release closes what it claimed
 * (`issues.release_batch_run_id`) and answers its own criteria hold; a design-only issue needs no one,
 * its approved revisions being what it delivered (REQ-45 BC-4), and neither does an adoption-only one
 * while its record holds (REQ-5 BC-17). Otherwise the close is the holding run's (`notTheHolder`, as
 * its move here was, `held` naming who else holds it), and each criterion it did not meet is moved out on the record first
 * (`close-in-scope.ts`); `moved` takes the moves for the close to write.
 */
export async function inScopeGuard(
  ctx: GuardContext,
  held: GuardFault | null,
  moved: { moves: MovedCriterion[] } | undefined,
): Promise<GuardFault | null> {
  const rows = (await ctx.executor.execute(
    sql`SELECT release_batch_run_id FROM issues WHERE id = ${ctx.issue.id}`,
  )) as unknown as Array<{ release_batch_run_id: string | null }>;
  if (rows[0]?.release_batch_run_id) return null;
  // an adoption-only issue ships nothing either: the record it adopted is what landed (REQ-5 BC-17)
  const adoption = await readAdoptionDelivery(ctx.executor, ctx.issue.id);
  if (adoption.refs && !adoption.shortfall) return null;
  const design = await readDesignDelivery(ctx);
  if (design.designOnly && design.unapproved.length === 0 && design.approved.length > 0)
    return null;
  if (held) {
    const why = design.designOnly ? ` It is design-only, and ${designShortfall(design)}.` : '';
    const shortfall = adoption.shortfall
      ? ` Its mark is an adoption record that no longer holds: ${adoption.shortfall}.`
      : '';
    return {
      ...held,
      detail: `${held.detail} An issue closes when its criteria are met in scope, by the run that holds it, or by a release that claimed it: finishing a release batch carrying it (\`POST /api/projects/${ctx.issue.projectId}/release-batches\`) or recording the release that already happened (\`POST /api/projects/${ctx.issue.projectId}/release-records\`) closes every issue it carries.${why}${shortfall}`,
      details: { ...held.details, designOnly: design.designOnly, adopted: adoption.refs },
    };
  }
  const scope = await closeScopeOf(
    ctx.executor,
    ctx.issue,
    ctx.facts.closeScope ?? { unmet: [], issues: new Map() },
  );
  if (scope.unplaced.length > 0) {
    return {
      code: 'CLOSE_CRITERION_UNPLACED',
      detail: unplacedDetail(scope.unplaced),
      details: {
        from: ctx.from,
        to: ctx.to,
        unplaced: scope.unplaced,
        destinations: ['next_batch_issue', 'new_issue', 'requirement'],
      },
    };
  }
  if (moved) moved.moves = scope.moves;
  return null;
}
