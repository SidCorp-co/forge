// Carrying a parked run's question to a room, and remembering which thread it went to.
//
// The obligation is DERIVED, never inserted: an open `human` question whose
// latest round has no delivered row here is a round still owed to somebody. So
// `questions/` writes nothing for this lane and imports nothing from here, and
// a core that dies between the kernel commit and any emit leaves the work to be
// found on the next drain rather than lost.

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issues, organizations, projects } from '../../db/schema.js';
import { agentQuestions, type QuestionOrigin } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import { activeIssuePrefix } from '../../issues/issue-prefix-read.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import { screenForDoor } from '../../messaging/proven.js';
import { resolveNotifications } from '../../notifications/auto-resolve.js';
import { emitNotification } from '../../notifications/emit.js';
import { sendFixedReply } from './outbound.js';
import { isUnreachableRoom, resolveQuestionDestination } from './question-destination.js';
import { renderRound } from './question-render.js';
import { resolveRoomPostAuth } from './room-delivery.js';
import { registerThread, releaseQuestionThread } from './thread-registry.js';

const RETRY_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 8;
// cm:guard an undeliverable round is NOT capped by MAX_ATTEMPTS and retries flat forever, because what it waits on is a person binding a room — a capped retry would make a room bound an hour late deliver nothing, which is the one thing criterion 25 forbids.
const UNBOUND_RETRY_MS = 300_000;

export interface OwedRound {
  questionId: string;
  projectId: string;
  issueId: string | null;
  round: number;
  attempts: number;
  /** This round has already been reported as having nowhere to go. */
  wasUndeliverable: boolean;
}

/**
 * Every round a room is still owed, whether or not it has ever been attempted.
 */
// cm:guard derived from `agent_questions` and never from a queue of its own: a row this query cannot see is a question nobody was told about, and the only way to keep that impossible is for the obligation to be the QUESTION rather than a record of intent to deliver it (ISS-978 criterion 5).
// cm:guard `jsonb_array_length(steps)` is the round, because `askFollowUp` appends a step rather than writing a second row — reading a `round` column that does not exist is how a follow-up would look already delivered.
export async function owedRounds(now: Date = new Date()): Promise<OwedRound[]> {
  const round = sql<number>`jsonb_array_length(${agentQuestions.steps})`;
  const rows = await db
    .select({
      questionId: agentQuestions.id,
      projectId: agentQuestions.projectId,
      issueId: agentQuestions.issueId,
      round,
      attempts: rocketchatQuestionDeliveries.attempts,
      status: rocketchatQuestionDeliveries.status,
    })
    .from(agentQuestions)
    .leftJoin(
      rocketchatQuestionDeliveries,
      and(
        eq(rocketchatQuestionDeliveries.questionId, agentQuestions.id),
        eq(rocketchatQuestionDeliveries.round, round),
      ),
    )
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        or(
          isNull(rocketchatQuestionDeliveries.id),
          and(
            sql`${rocketchatQuestionDeliveries.status} <> 'delivered'`,
            or(
              sql`${rocketchatQuestionDeliveries.status} = 'undeliverable'`,
              sql`${rocketchatQuestionDeliveries.attempts} < ${MAX_ATTEMPTS}`,
            ),
            or(
              isNull(rocketchatQuestionDeliveries.nextAttemptAt),
              lte(rocketchatQuestionDeliveries.nextAttemptAt, now),
            ),
          ),
        ),
      ),
    );
  return rows.map((r) => ({
    questionId: r.questionId,
    projectId: r.projectId,
    issueId: r.issueId,
    round: r.round,
    attempts: r.attempts ?? 0,
    wasUndeliverable: r.status === 'undeliverable',
  }));
}

const undeliverableKey = (questionId: string) => `rocketchat-question-undeliverable:${questionId}`;

// cm:guard the person told is the org's creator, resolved as `escalation-bridge.ts` resolves it, because a project with NO binding has no route to read a principal off — and a question nobody can be told about is exactly the state this notification exists to make visible (ISS-978 criterion 24).
// cm:guard fired ONCE per question, on the move into undeliverable and never on the retries after it: `createNotification` inserts unconditionally — `resolutionKey` is what a later resolver clears, not a dedup key — so a per-retry call would put a row in somebody's list every five minutes for as long as the project has no room.
// cm:guard the REASON is carried in rather than restated here, because there is no longer one cause: since ISS-1091 a round is undeliverable when no room is bound, when the conversation it was asked in has no route back, when the bot has been removed from that room, when a private round's asker cannot be reached, and when the venue is a surface this lane does not post to. A fixed sentence about binding a room tells an operator to fix something that is not broken (ISS-1091 criterion 14).
async function reportUndeliverable(
  owed: OwedRound,
  already: boolean,
  reason: string,
): Promise<void> {
  if (already) return;
  const [row] = await db
    .select({ slug: projects.slug, name: projects.name, createdBy: organizations.createdBy })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, owed.projectId))
    .limit(1);
  if (!row?.createdBy) return;
  await emitNotification({
    userId: row.createdBy,
    projectId: owed.projectId,
    issueId: owed.issueId,
    type: 'ops_alert',
    severity: 'warning',
    title: `${row.name} has a question waiting that cannot be delivered`,
    body: `A question is waiting on a person and ${row.slug} has nowhere to put it: ${reason}. Nothing was posted anywhere. Put that right and the question is delivered on the next sweep — whoever asked does not have to ask again.`,
    resolutionKey: undeliverableKey(owed.questionId),
  });
}

/**
 * Take this round, so no other core instance posts it too. Null when somebody else holds it.
 */
// cm:guard ONE statement, and the `where` on the conflict branch is what makes it a claim: the drain runs on EVERY core instance, and the DDP connection's advisory lock guards the socket rather than this table. Two instances deriving the same owed round and both posting is a question asked twice in one room, and `onConflictDoUpdate` without this predicate prevents only the second ROW (ISS-978 criterion 5).
// cm:guard the claim is written BEFORE the post and is deliberately not `delivered`: it says an attempt is in flight, never that one succeeded, so a claim whose process died is retried the moment its `next_attempt_at` passes rather than being mistaken for a delivery (ISS-978 criterion 6).
// cm:guard the attempt count is computed BY THE ROW and read back, never carried in from the derivation:
// `owedRounds` reads every round before the loop posts any of them, so `owed.attempts` is a value from
// before this claim and writing `owed.attempts + 1` under `set:` is a lost update — a second drain that
// derived the same round at the same moment overwrites the first one's increment with its own copy of
// the same stale number. The count then stops rising, `MAX_ATTEMPTS` is never reached, and the
// exhaustion branch below — the one thing that tells anybody a question will not be asked — never runs
// (ISS-978 F2).
// cm:guard `now` is taken at the CLAIM and not handed down from the drain: the loop is sequential and
// posts to another host, so a `now` captured before it can be minutes stale by the time a later round
// is claimed, and `nextAttemptAt = staleNow + backoff` is then a retry time already in the past. That
// round is immediately re-derivable by any other core instance while this one is still posting it,
// which is the same question in the same room twice (ISS-978 F1).
// cm:guard serialise to ISO and cast before binding — postgres-js throws on a raw `Date` param at bind time, so the claim fails rather than mis-selecting and the whole drain is lost.
async function claimRound(owed: OwedRound, now: Date): Promise<number | null> {
  const attempts = sql<number>`coalesce(${rocketchatQuestionDeliveries.attempts}, 0) + 1`;
  const claimed = await db
    .insert(rocketchatQuestionDeliveries)
    .values({
      questionId: owed.questionId,
      round: owed.round,
      status: 'claimed',
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [rocketchatQuestionDeliveries.questionId, rocketchatQuestionDeliveries.round],
      set: {
        status: 'claimed',
        attempts,
        nextAttemptAt: sql`${now.toISOString()}::timestamptz + (${RETRY_BACKOFF_MS} * ${attempts}) * interval '1 millisecond'`,
        updatedAt: now,
      },
      setWhere: sql`${rocketchatQuestionDeliveries.status} <> 'delivered' and (${rocketchatQuestionDeliveries.nextAttemptAt} is null or ${rocketchatQuestionDeliveries.nextAttemptAt} <= ${now.toISOString()}::timestamptz)`,
    })
    .returning({ attempts: rocketchatQuestionDeliveries.attempts });
  // cm:guard an empty `returning` is the claim being REFUSED by `setWhere` — another instance holds the
  // round — and is the only thing that reads as null here. A row that came back without its count would
  // be a schema that has stopped matching this query, so it throws rather than being read as a refusal:
  // silently treating it as held would wedge every delivery on this box with nothing in the log.
  const row = claimed[0];
  if (!row) return null;
  if (typeof row.attempts !== 'number') {
    throw new Error(
      `rocketchat.question-delivery: the claim on question ${owed.questionId} round ${owed.round} returned a row with no attempt count`,
    );
  }
  return row.attempts;
}

async function settle(
  owed: OwedRound,
  patch: { status: 'delivered' | 'undeliverable'; lastError?: string | null },
  now: Date,
): Promise<void> {
  await db
    .update(rocketchatQuestionDeliveries)
    .set({
      status: patch.status,
      lastError: patch.lastError ?? null,
      nextAttemptAt:
        patch.status === 'delivered' ? null : new Date(now.getTime() + UNBOUND_RETRY_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(rocketchatQuestionDeliveries.questionId, owed.questionId),
        eq(rocketchatQuestionDeliveries.round, owed.round),
      ),
    );
}

// cm:guard the LAST attempt settles the round instead of recording a failure, because `owedRounds`
// selects on `attempts < MAX_ATTEMPTS`: a round that merely records its eighth failure stops being
// selected with `claimed` still on it, no terminal status, no notification and nothing logged at the
// moment of the drop — it falls out of a `WHERE`. Nothing else reads this table, so nobody is ever
// told the question will not be asked while the run stays parked on it. That is the contract's "a
// silence is OURS" (ISS-978). `refuse` is the one place that settles and tells, so exhaustion goes
// through it like every other cause; `undeliverable` then retries flat and uncapped, which is right
// here too — a parked run still needs its question asked, and the operator has been told once.
// cm:guard the number read here is the one the CLAIM wrote and returned, not `owed.attempts + 1`: the
// derivation's copy is from before the claim, so the exhaustion test would be taken against a count
// that a competing drain has already moved past — the round would keep failing quietly beyond
// MAX_ATTEMPTS and never settle (ISS-978 F1, F2).
async function noteFailure(
  owed: OwedRound,
  attempt: number,
  lastError: string,
  now: Date,
): Promise<'failed' | 'undeliverable'> {
  if (attempt >= MAX_ATTEMPTS) {
    return refuse(
      owed,
      `this round failed ${attempt} times and will not be retried on the ordinary schedule — the last failure was: ${lastError}`,
      now,
    );
  }
  await db
    .update(rocketchatQuestionDeliveries)
    .set({ lastError, updatedAt: now })
    .where(
      and(
        eq(rocketchatQuestionDeliveries.questionId, owed.questionId),
        eq(rocketchatQuestionDeliveries.round, owed.round),
      ),
    );
  return 'failed';
}

/**
 * Deliver one owed round. Never throws — a failure is a record, not an exception.
 */
// cm:guard the ORDER is the contract: claim, then post, then mark delivered. Claiming first stops a second core instance posting the same round; marking last is what keeps `delivered` a statement about a post that returned a message id rather than about one that was attempted (ISS-978 criteria 5, 6, 7, 8).
// cm:guard a follow-up round posts into the FIRST round's thread and never opens a second one: one decision is one thread, matching the one-row-per-decision rule `agent_questions` holds (ISS-978 criterion 9).
export async function deliverOwedRound(
  owed: OwedRound,
  now: Date = new Date(),
): Promise<'delivered' | 'failed' | 'undeliverable' | 'held'> {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, owed.questionId))
    .limit(1);
  if (!question) return 'failed';
  const step = question.steps[owed.round - 1];
  if (!step) return 'failed';

  const attempt = await claimRound(owed, now);
  if (attempt === null) return 'held';

  const destination = await resolveQuestionDestination({
    questionId: owed.questionId,
    projectId: owed.projectId,
    origin: question.origin ?? null,
    step,
  });
  if (destination.kind === 'unresolvable') {
    return refuse(owed, destination.reason, now);
  }

  const [issue] = owed.issueId
    ? await db
        .select({ issSeq: issues.issSeq })
        .from(issues)
        .where(eq(issues.id, owed.issueId))
        .limit(1)
    : [];
  // cm:guard the round is RENDERED before it is screened, and the screen reads the value the render
  // handed back rather than a segment list assembled beside it. Those were two expressions here until
  // ISS-978 — `screenAtDoor(..., agentAuthoredSegments(step))` and `renderRound(...)` — with nothing
  // but intent connecting the string that was judged to the string that was posted, which is exactly
  // what F5 found. The render now owns both halves and `screenForDoor` mints a proof naming the text.
  const screening = screenForDoor(
    'question-delivery',
    renderRound({
      issueKey: issue?.issSeq
        ? formatIssueRef(await activeIssuePrefix(owed.projectId), issue.issSeq)
        : null,
      step,
      rounds: question.steps.length,
      parkDeadlineAt: question.parkDeadlineAt ?? null,
      askedBy: askerOf(question.origin ?? null),
    }),
  );
  if (!screening.ok) {
    // cm:guard the refusal is NOT posted as a fallback message into the room: the only text this round has is the text that failed the screen, and posting a stand-in would tell somebody a decision is waiting while hiding what it is. The round stays owed and the log names the problems (ISS-978 criterion 28).
    logger.error(
      {
        questionId: owed.questionId,
        round: owed.round,
        problems: problemsOf(screening.verdict),
      },
      'rocketchat.question-delivery: the round was refused by the operator screen; not posted',
    );
    return await noteFailure(
      owed,
      attempt,
      `screen refused the round: ${problemsOf(screening.verdict).join('; ')}`,
      now,
    );
  }

  const auth = await resolveRoomPostAuth(destination.connectionId, {
    source: 'rocketchat.question-delivery',
    questionId: owed.questionId,
  });
  if (!auth) {
    return await noteFailure(owed, attempt, 'the connection carries no usable credentials', now);
  }

  const ref = {
    connectionId: destination.connectionId,
    rid: destination.rid,
    tmid: destination.tmid ?? '',
  };
  // cm:guard an anchored round TAKES its thread before it posts, and this is the whole of the race: the anchor is a message that already exists, so two questions raised against it would both pass a read-then-post and this insert would drop one of them in silence — after which every reply in that thread answers one question and the other waits for ever. `registerThread` answers whether the triple is ours, and a round that did not take it is refused by name (ISS-1091 criteria 20, 21).
  if (destination.takeAnchor && destination.tmid) {
    const took = await registerThread({ questionId: owed.questionId }, ref);
    if (!took) {
      return refuse(
        owed,
        `the message this question was raised against (${destination.tmid}) is already another thread's root, so this round cannot be hung under it`,
        now,
      );
    }
  }

  // cm:guard the POST has a try of its own, and the anchor is given back only from here. A post that returned is a message somebody can already see and reply to, so releasing the anchor after one would leave a real round standing under a triple nothing owns: replies to it open ordinary windows, and another question can take the same anchor and consume them. Releasing is about an anchor whose message never appeared, which is exactly and only a post that threw (ISS-1091 criteria 20, 21).
  let receipt: { messageId: string | null };
  try {
    receipt = await sendFixedReply(
      {
        kind: 'rest',
        auth,
        rid: destination.rid,
        ...(destination.tmid ? { tmid: destination.tmid } : {}),
      },
      screening.proven.text,
      screening.proven,
    );
  } catch (err) {
    await releaseTakenAnchor(destination, owed.questionId);
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid: destination.rid },
      'rocketchat.question-delivery: posting the round failed',
    );
    // cm:guard a room the bot has been REMOVED from is a destination, not a flake: its binding is live so the round resolves, and counted as a retryable failure it burns MAX_ATTEMPTS and then stops being owed with nobody told — a question that quietly ceases to exist (ISS-1091 criterion 13).
    if (isUnreachableRoom(err)) {
      return refuse(
        owed,
        `this bot can no longer post in room ${destination.rid}, which is where this question was asked`,
        now,
      );
    }
    return await noteFailure(owed, attempt, err instanceof Error ? err.message : String(err), now);
  }

  // cm:guard everything past the post KEEPS the anchor, whatever it does: the round is on the wall of a room, and the retry that follows has to find the same triple rather than race a competitor for it.
  try {
    const tmid = destination.tmid ?? receipt.messageId;
    if (!tmid) {
      return await noteFailure(
        owed,
        attempt,
        'the post named no message id, so no thread can be registered',
        now,
      );
    }
    // cm:guard the thread is registered BEFORE the round is marked delivered: a round marked delivered with no thread row is a message in a room whose replies reach nothing, and this order makes that state unreachable rather than merely unlikely (ISS-978 criterion 7).
    await registerThread(
      { questionId: owed.questionId },
      { connectionId: destination.connectionId, rid: destination.rid, tmid },
    );
    await settle(owed, { status: 'delivered' }, now);
    await resolveNotifications(undeliverableKey(owed.questionId));
    return 'delivered';
  } catch (err) {
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid: destination.rid },
      'rocketchat.question-delivery: the round was posted and recording it failed',
    );
    return await noteFailure(owed, attempt, err instanceof Error ? err.message : String(err), now);
  }
}

/** Settle this round undeliverable, tell the operator once, and post nothing anywhere. */
// cm:guard the ONE place a round becomes undeliverable, so the reason on the row and the reason in the notification cannot drift, and so no branch can settle one without telling anybody. It posts nothing: widening back to `roomForProject` is the defect ISS-1091 exists to remove, and for a round marked private it would be a disclosure rather than a misdelivery.
async function refuse(owed: OwedRound, reason: string, now: Date): Promise<'undeliverable'> {
  await settle(owed, { status: 'undeliverable', lastError: reason }, now);
  await reportUndeliverable(owed, owed.wasUndeliverable, reason);
  return 'undeliverable';
}

/** Give back an anchor this attempt took, and only one this attempt took. */
async function releaseTakenAnchor(
  destination: { takeAnchor: boolean; connectionId: string; rid: string; tmid: string | null },
  questionId: string,
): Promise<void> {
  if (!destination.takeAnchor || !destination.tmid) return;
  await releaseQuestionThread(questionId, {
    connectionId: destination.connectionId,
    rid: destination.rid,
    tmid: destination.tmid,
  });
}

/** Who this round is being put to, where the question remembers. */
function askerOf(origin: QuestionOrigin | null): string | null {
  return origin?.kind === 'conversation' ? origin.askedByLabel : null;
}

export interface QuestionDrainResult {
  owed: number;
  delivered: number;
  failed: number;
  undeliverable: number;
  /** Rounds another core instance was already posting. */
  held: number;
}

// cm:guard the clock is READ PER ROUND and not once for the pass: this loop is sequential and every
// iteration posts to another host, so a drain over a dozen owed rounds spans minutes. A single `now`
// captured at the top then becomes the retry time written for the LAST round — `staleNow + backoff`
// can already be in the past when it lands, which makes that round immediately re-derivable by any
// other core instance while this one is still posting it. That is the same question in the same room
// twice, which is the one thing `claimRound` exists to prevent (ISS-978 F1).
// cm:why a caller may still pass a fixed `Date`, and that means "hold time here": the retry-schedule
// tests drive the backoff by moving one value, and a clock they cannot freeze is a clock they cannot
// test against.
export async function drainQuestionDeliveries(
  clock: Date | (() => Date) = () => new Date(),
): Promise<QuestionDrainResult> {
  const at = typeof clock === 'function' ? clock : (): Date => clock;
  const owed = await owedRounds(at());
  const result: QuestionDrainResult = {
    owed: owed.length,
    delivered: 0,
    failed: 0,
    undeliverable: 0,
    held: 0,
  };
  for (const round of owed) {
    const outcome = await deliverOwedRound(round, at());
    result[outcome] += 1;
  }
  return result;
}

/** The drain is a backstop, not the fast path: a newly asked question goes out on the next tick. */
const DRAIN_INTERVAL_MS = 30_000;

/**
 * Run the drain on a timer until the returned stopper is called.
 */
// cm:guard runs even with zero live connections and keeps running when every dial fails, because what it drains is derived from `agent_questions`: a project that has just had its first room bound is delivered by this timer and by nothing the binding itself did (ISS-978 criterion 25).
// cm:guard one drain at a time — a tick that overlaps its predecessor would re-derive the same owed rounds and post a question twice, since a round is not marked until its post returns.
export function startQuestionDrainLoop(alive: () => boolean): () => void {
  let running = false;
  const tick = (): void => {
    if (running || !alive()) return;
    running = true;
    void drainQuestionDeliveries()
      .then((r) => {
        if (r.owed > 0) logger.info({ ...r }, 'rocketchat: question delivery drain');
      })
      .catch((err) => logger.error({ err }, 'rocketchat: question delivery drain failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, DRAIN_INTERVAL_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
