/**
 * What a requirement owes before its delivery starts (REQ-67 BC-1..BC-5): the questions still open
 * about it, the gaps the kernel can see, and whether the steward has checked it since its head was
 * agreed. One read serves the move's guard, which refuses naming each open question and a missing
 * check at once (`REQUIREMENT_CHECKED_GUARD`), the requirement's read and the steward's check, which
 * turns the gaps into the questions it needs about the requirement. Each refusal names the act that
 * clears it and its door (ISS-1084): a question's answer door, or where the steward's check stands
 * and when the standing sweep starts it again (`checksOwedIn`).
 *
 * A gap is a fact, never a judgement: whether each criterion can be checked on the running product
 * is the steward's to judge, and it asks about what it finds.
 * - `no_workflow` only where the project draws workflows: a project with none is not frozen by them.
 * - `untraced_workflow`: a linked workflow no live criterion traces a step of, so its picture lights
 *   nothing.
 * - `conflict` and `duplicate`: a link the intake draft wrote to a live requirement, settled once a
 *   decision recorded on this requirement after the draft names that requirement (an answered
 *   question reaches it as one), or once the linked requirement has ended; a conflict also once the
 *   criterion it quoted is no longer live there.
 */

import type {
  DeliveryCheckAttempt,
  DeliveryCheckAttemptState,
  DeliveryCheckQuestion,
  DeliveryGap,
  RequirementDeliveryCheck,
} from '@forge/contracts/delivery-check';
import { REQUIREMENT_LIFECYCLE, requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { gateOf, readProjectDocument } from '../project-config/index.js';
import type { RequirementRefusal } from './rules.js';
import type { DeliveryHold } from './standing-held.js';

/** The requirement the check reads: its id, key and head. */
export interface CheckedRow {
  id: string;
  projectId: string;
  reqSeq: number;
  currentRevision: number | null;
}

/** Whether the project's steward is on, read before the move's lock: on unless its document says otherwise. */
export async function stewardOn(projectId: string): Promise<boolean> {
  return (await readProjectDocument(projectId))?.document.steward?.enabled ?? true;
}

/** A linked requirement still on the lifecycle line; dropped, deferred and refused have ended. */
const liveStatus = (s: string) => (REQUIREMENT_LIFECYCLE as readonly string[]).includes(s);

/** `ids` as a SQL list of uuids. */
const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * The questions open about each of `ids`, oldest first: each asked of it or about it that a person or
 * the master owes (outside strict the master answers them, `questions/owed.ts`), but one its
 * revisions list as not blocking by that question's newest entry (asked, never required: REQ-34
 * BC-17, so the delivery waits on it no more than the agree did). Each is a question row, so a
 * refusal naming it names a door that serves it (ISS-1084): a question comment a steward check posted
 * before ISS-688 was read here as one, named at a `questions/:id` that answered 404, until migration
 * 0623 asked each still open as a question under its own id.
 */
async function openQuestionsOf(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, DeliveryCheckQuestion[]>> {
  const out = new Map<string, DeliveryCheckQuestion[]>();
  if (ids.length === 0) return out;
  const rows = rowsOf<{
    rid: string;
    id: string;
    prompt: string | null;
    asked_at: string | Date;
    blocker_kind: string;
  }>(
    await tx.execute(sql`
      SELECT r.id AS rid, q.id, q.steps -> -1 ->> 'prompt' AS prompt, q.created_at AS asked_at,
             q.blocker_kind
        FROM requirements r
        JOIN agent_questions q
          ON q.project_id = r.project_id
         AND q.status = 'open'
         AND q.blocker_kind IN ('human', 'master_or_peer')
         AND q.batch_id IS NULL
         AND (q.requirement_id = r.id
              OR (q.about ->> 'kind' = 'requirement' AND q.about ->> 'requirementId' = r.id::text))
       WHERE r.id IN (${idList(ids)})
         AND coalesce((
           SELECT (e ->> 'blocking')::boolean
             FROM requirement_revisions rv
             CROSS JOIN LATERAL jsonb_array_elements(coalesce(rv.spec -> 'openQuestions', '[]'::jsonb)) e
            WHERE rv.requirement_id = r.id AND e ->> 'questionId' = q.id::text
            ORDER BY rv.revision DESC
            LIMIT 1), true)
       ORDER BY q.created_at, q.id`),
  );
  for (const r of rows) {
    const list = out.get(r.rid) ?? [];
    list.push({
      id: r.id,
      prompt: r.prompt ?? '',
      askedAt: new Date(r.asked_at).toISOString(),
      owedBy: r.blocker_kind === 'human' ? 'person' : 'master',
    });
    out.set(r.rid, list);
  }
  return out;
}

async function workflowGaps(tx: Tx, row: CheckedRow): Promise<DeliveryGap[]> {
  const linked = rowsOf<{ flow: string; title: string | null; traced: boolean }>(
    await tx.execute(sql`
      SELECT w.flow, w.document ->> 'title' AS title,
             EXISTS (
               SELECT 1 FROM requirement_criterion_steps s
                 JOIN requirement_criteria c
                   ON c.requirement_id = s.requirement_id AND c.code = s.code
                  AND c.retired_revision IS NULL
                WHERE s.requirement_id = rw.requirement_id AND s.workflow_id = w.id) AS traced
        FROM requirement_workflows rw
        JOIN project_workflows w ON w.id = rw.workflow_id
       WHERE rw.requirement_id = ${row.id}
       ORDER BY w.flow`),
  );
  if (linked.length === 0) {
    const [drawn] = rowsOf<{ n: number }>(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM project_workflows WHERE project_id = ${row.projectId}`,
      ),
    );
    if (!drawn?.n) return [];
    return [
      {
        kind: 'no_workflow',
        ref: null,
        title: null,
        detail:
          'it names no workflow it changes; link the workflow it changes, so its picture shows the steps it touches.',
      },
    ];
  }
  return linked
    .filter((w) => !w.traced)
    .map((w) => ({
      kind: 'untraced_workflow' as const,
      ref: w.flow,
      title: w.title ?? w.flow,
      detail: `no criterion traces a step of the workflow ${w.title ?? w.flow}, so its picture lights none; trace the steps each criterion changes.`,
    }));
}

interface LinkRow {
  relation: 'conflict' | 'duplicate';
  key: string;
  title: string | null;
  basis: string | null;
  status: string | null;
  quoted_live: boolean;
  decided: boolean;
}

async function linkGaps(tx: Tx, row: CheckedRow): Promise<DeliveryGap[]> {
  const links = rowsOf<LinkRow>(
    await tx.execute(sql`
      SELECT l ->> 'relation' AS relation,
             upper(l -> 'ref' ->> 'key') AS key,
             l -> 'ref' ->> 'title' AS title,
             l ->> 'basis' AS basis,
             r.status,
             EXISTS (
               SELECT 1 FROM requirement_criteria c
                WHERE c.requirement_id = r.id AND c.retired_revision IS NULL
                  AND c.body = l ->> 'basis') AS quoted_live,
             EXISTS (
               SELECT 1 FROM comments d
                WHERE d.requirement_id = ${row.id} AND d.intent = 'decision'
                  AND d.created_at > dr.drafted_at
                  AND d.body ~* ('\\m' || (l -> 'ref' ->> 'key') || '\\M')) AS decided
        FROM intake_drafts dr
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(dr.body -> 'links', '[]'::jsonb)) l
        LEFT JOIN requirements r
          ON r.project_id = dr.project_id
         AND 'REQ-' || r.req_seq = upper(l -> 'ref' ->> 'key')
       WHERE dr.requirement_id = ${row.id}
         AND dr.outcome = 'drafted'
         AND l ->> 'relation' IN ('conflict', 'duplicate')
         AND l -> 'ref' ->> 'kind' = 'requirement'`),
  );
  const own = requirementKey(row.reqSeq);
  return links
    .filter(
      (l) =>
        l.key !== own &&
        l.status !== null &&
        liveStatus(l.status) &&
        !l.decided &&
        (l.relation === 'duplicate' || l.quoted_live),
    )
    .map((l) => ({
      kind: l.relation,
      ref: l.key,
      title: l.title,
      detail:
        l.relation === 'conflict'
          ? `it contradicts ${l.key} on "${l.basis ?? ''}"; record which holds as a decision on ${own}, or revise one of them.`
          : `it repeats ${l.key}; record whether both are built as a decision on ${own}, or merge or drop one of them.`,
    }));
}

/** The steward's acts that check a requirement before its delivery: a run ending done finished one. */
const CHECK_ACTS = sql.raw(`ARRAY['intake_check', 'breakdown_check']::text[]`);

/** When its head was agreed: the runs that count are those live or ended since. */
const agreedAt = (row: CheckedRow) => sql`(
  SELECT coalesce(rv.decided_at, rv.created_at) FROM requirement_revisions rv
   WHERE rv.requirement_id = ${row.id} AND rv.revision = ${row.currentRevision})`;

/**
 * When the steward last finished checking each of `ids` since its head was agreed; absent where it
 * has not. A run carrying a check takes the check alone (`steward/dispatch.ts:runOne`), so its end is
 * the check's.
 */
async function checkedAtOf(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf<{ id: string; at: string | Date }>(
    await tx.execute(sql`
      SELECT r.id, max(sr.ended_at) AS at
        FROM requirements r
        JOIN requirement_revisions rv
          ON rv.requirement_id = r.id AND rv.revision = r.current_revision
        JOIN steward_runs sr
          ON sr.subject_kind = 'requirement'
         AND sr.subject_id = r.id
         AND sr.state = 'done'
         AND sr.acts_to_run && ${CHECK_ACTS}
         AND sr.ended_at >= coalesce(rv.decided_at, rv.created_at)
       WHERE r.id IN (${idList(ids)})
       GROUP BY r.id`),
  );
  return new Map(rows.map((r) => [r.id, new Date(r.at).toISOString()]));
}

/**
 * The latest check of it tried since its head was agreed, none having finished: live (queued or
 * running, the check in its acts or waiting behind them) or ended without finishing. Null where none
 * has been tried, which the standing sweep raises (`steward/owed-checks.ts`).
 */
async function attemptOf(tx: Tx, row: CheckedRow): Promise<DeliveryCheckAttempt | null> {
  const [hit] = rowsOf<{
    state: DeliveryCheckAttemptState;
    at: string | Date;
    failure: string | null;
    skip_reason: string | null;
  }>(
    await tx.execute(sql`
      SELECT sr.state, coalesce(sr.ended_at, sr.started_at, sr.queued_at) AS at, sr.failure,
             sr.skip_reason
        FROM steward_runs sr
       WHERE sr.subject_kind = 'requirement'
         AND sr.subject_id = ${row.id}
         AND (sr.acts_to_run && ${CHECK_ACTS}
              OR (sr.state IN ('queued', 'running') AND sr.follow_up && ${CHECK_ACTS}))
         AND coalesce(sr.ended_at, now()) >= ${agreedAt(row)}
       ORDER BY sr.state IN ('queued', 'running') DESC, coalesce(sr.ended_at, sr.queued_at) DESC
       LIMIT 1`),
  );
  if (!hit) return null;
  return {
    state: hit.state,
    at: new Date(hit.at).toISOString(),
    why: hit.failure ? (hit.failure.split('\n')[0] ?? null) : hit.skip_reason,
  };
}

/** The delivery check of an agreed requirement, read inside `tx`; `owed` says whether the steward is on. */
export async function deliveryCheckIn(
  tx: Tx,
  row: CheckedRow,
  owed: boolean,
): Promise<RequirementDeliveryCheck> {
  const questions = (await openQuestionsOf(tx, [row.id])).get(row.id) ?? [];
  const workflows = await workflowGaps(tx, row);
  const links = await linkGaps(tx, row);
  const checked =
    owed && row.currentRevision !== null
      ? ((await checkedAtOf(tx, [row.id])).get(row.id) ?? null)
      : null;
  const attempt =
    owed && row.currentRevision !== null && checked === null ? await attemptOf(tx, row) : null;
  const gaps = [...workflows, ...links];
  return {
    owed,
    checkedAt: checked,
    attempt,
    questions,
    gaps,
    clear: questions.length === 0 && (!owed || checked !== null),
  };
}

/**
 * What of the delivery check would refuse each agreed requirement's move into delivery now, read
 * for the standing (ISS-1084, FB-561): the same questions and check the move's guard reads, where the
 * project's gate `requirement_checked` enforces it. A requirement nothing holds is absent.
 */
export async function deliveryHoldsOf(
  projectId: string,
  rows: readonly { id: string; status: string; currentRevision: number | null }[],
): Promise<Map<string, DeliveryHold>> {
  const ids = rows
    .filter((r) => r.status === 'agreed' && r.currentRevision !== null)
    .map((r) => r.id);
  if (ids.length === 0) return new Map();
  const [gate, owed] = await Promise.all([
    gateOf(projectId, 'requirement_checked'),
    stewardOn(projectId),
  ]);
  if (gate.mode !== 'enforce') return new Map();
  const [questions, checked] = await Promise.all([
    openQuestionsOf(db, ids),
    owed ? checkedAtOf(db, ids) : Promise.resolve(new Map<string, string>()),
  ]);
  const out = new Map<string, DeliveryHold>();
  for (const id of ids) {
    const open = questions.get(id) ?? [];
    const unchecked = owed && !checked.has(id);
    if (open.length === 0 && !unchecked) continue;
    out.set(id, {
      questions: open.length,
      person: open.some((q) => q.owedBy === 'person'),
      unchecked,
    });
  }
  return out;
}

/** How long after an ended check the standing sweep starts it again (`steward/owed-checks.ts`). */
export const CHECK_RETRY_MS = 60 * 60_000;
/** How long after its agree a requirement no check was tried on waits for the sweep to start one. */
export const CHECK_UNTRIED_GRACE_MS = 5 * 60_000;

/** Where its check stands and what takes it on, as the refusal says it. */
function uncheckedDetail(attempt: DeliveryCheckAttempt | null, runs: string): string {
  const read = `the steward's runs on it read at GET ${runs}; nothing of it is the master's to do`;
  if (!attempt) {
    return `the steward has not finished a check of it since its head was agreed, and none has been tried; the standing sweep starts one within 15 minutes of its agree (${read}).`;
  }
  if (attempt.state === 'queued' || attempt.state === 'running') {
    return `the steward's check of it is ${attempt.state} since ${attempt.at}; delivery may start once it ends done (${read}).`;
  }
  const again = new Date(Date.parse(attempt.at) + CHECK_RETRY_MS).toISOString();
  return `the steward's last check of it ended ${attempt.state} at ${attempt.at} (${attempt.why ?? 'no reason recorded'}); the standing sweep starts it again an hour after it ended, from ${again} (${read}).`;
}

/**
 * Every refusal the check holds the move into delivery with, at once; empty where it holds none. A
 * gap is never one (owner rulings 2026-10-31, 2026-11-01): it goes back as a question on the
 * requirement, which the steward's check asks and the master answers, so the move waits on the
 * question and on the check, never on a canned list. Each names the act that clears it and its door.
 */
export function deliveryCheckRefusals(
  check: RequirementDeliveryCheck,
  row: Pick<CheckedRow, 'projectId' | 'reqSeq'>,
): RequirementRefusal[] {
  const runs = `/api/projects/${row.projectId}/steward-runs?subject=${requirementKey(row.reqSeq)}`;
  return [
    ...check.questions.map((q) => ({
      code: 'REQUIREMENT_QUESTION_OPEN' as const,
      path: `/questions/${q.id}`,
      detail: `delivery waits on the answer to: ${q.prompt} It is owed by ${q.owedBy === 'master' ? "the project's master" : 'a person'}, and answered at POST /api/questions/${q.id}/answer.`,
    })),
    ...(check.owed && check.checkedAt === null
      ? [
          {
            code: 'REQUIREMENT_UNCHECKED' as const,
            path: '',
            detail: uncheckedDetail(check.attempt, runs),
          },
        ]
      : []),
  ];
}

/** An agreed requirement whose check the standing sweep starts: its id and key. */
export interface OwedCheck {
  id: string;
  key: string;
}

/**
 * The agreed requirements of `projectId` whose check is owed and nothing is taking (ISS-1084), oldest
 * agreed first, at most `limit`: none finished since the head was agreed, none live, and the last one
 * tried ended an hour ago (`CHECK_RETRY_MS`), or none was tried and the agree is past its grace. The
 * steward's handoff starts a check on each agree and breakdown; this is what starts one where that
 * check ended without finishing (adminhub-api REQ-22, forge REQ-45) or never ran.
 */
export async function checksOwedIn(
  projectId: string,
  now: Date,
  limit: number,
): Promise<OwedCheck[]> {
  if (limit <= 0) return [];
  const retry = new Date(now.getTime() - CHECK_RETRY_MS);
  const grace = new Date(now.getTime() - CHECK_UNTRIED_GRACE_MS);
  const rows = rowsOf<{ id: string; req_seq: number }>(
    await db.execute(sql`
      SELECT r.id, r.req_seq
        FROM requirements r
        JOIN requirement_revisions rv
          ON rv.requirement_id = r.id AND rv.revision = r.current_revision
        CROSS JOIN LATERAL (SELECT coalesce(rv.decided_at, rv.created_at) AS at) agreed
        LEFT JOIN LATERAL (
          SELECT max(sr.ended_at) AS at
            FROM steward_runs sr
           WHERE sr.subject_kind = 'requirement' AND sr.subject_id = r.id
             AND sr.acts_to_run && ${CHECK_ACTS} AND sr.ended_at >= agreed.at) tried ON true
       WHERE r.project_id = ${projectId}
         AND r.status = 'agreed'
         AND NOT EXISTS (
           SELECT 1 FROM steward_runs sr
            WHERE sr.subject_kind = 'requirement' AND sr.subject_id = r.id
              AND sr.acts_to_run && ${CHECK_ACTS}
              AND sr.state = 'done' AND sr.ended_at >= agreed.at)
         AND NOT EXISTS (
           SELECT 1 FROM steward_runs sr
            WHERE sr.subject_kind = 'requirement' AND sr.subject_id = r.id
              AND sr.state IN ('queued', 'running')
              AND (sr.acts_to_run && ${CHECK_ACTS} OR sr.follow_up && ${CHECK_ACTS}))
         AND (CASE WHEN tried.at IS NULL THEN agreed.at <= ${sqlTimestamp(grace)}
                   ELSE tried.at <= ${sqlTimestamp(retry)} END)
       ORDER BY agreed.at, r.id
       LIMIT ${limit}`),
  );
  return rows.map((r) => ({ id: r.id, key: requirementKey(Number(r.req_seq)) }));
}
