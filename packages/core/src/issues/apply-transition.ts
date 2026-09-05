import { and, count, eq, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import {
  comments,
  type IssueStatus,
  issues,
  jobs,
  pipelineRuns,
  type WaitingKind,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import { canTransitionFree, DRAFT_EXIT_TARGETS, isReopenEntry } from '../pipeline/state-machine.js';
import { collectWorkEvidence, hasCodeEvidence } from '../pipeline/work-evidence.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { actorAgency, type DeviceLite, type TransitionActor } from './actor-agency.js';
import { resolveAutonomousParkTarget } from './autonomous-park.js';
import { expireBlocksEdgesOnDrop, type UnblockedDependent } from './drop-cascade.js';
import { recordDropUnblock } from './drop-unblock.js';
import { markMergedIfLeavingBase, markMergedOnClose } from './merged-at.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { resolveAgentCloseTarget } from './release-gate-hold.js';
import { refuseUnrecordedClose } from './release-record-required.js';
import { checkTransitionEvidence } from './transition-evidence.js';
import { postTransitionReasonComment, requiresAuthoredReason } from './transition-reason.js';

/**
 * Issue statuses that free a `kind='blocks'` dependent (Layer 2) and fire the
 * terminal dispatch fan-out. Does NOT imply the run closes here — see
 * `RUN_CLOSING_STATUSES`.
 *
 * `released` and `closed` free a dependent by SATISFYING the edge — they stamp
 * `merged_at`, which is what the gate reads. `dropped` frees it the other way:
 * the edge is expired (`drop-cascade.ts`), so the gate finds no edge at all.
 * The two mechanisms are not interchangeable, and the difference is the whole
 * reason `dropped` exists — see `RUN_CLOSING_STATUSES` below.
 */
export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>(['released', 'closed', 'dropped']);

/**
 * Statuses that close the issue's open `pipeline_run`. Only `closed`:
 * `released` is ALSO the `release` job's dispatch-trigger status
 * (registry.ts), so closing the run on `released` orphaned it and forced the
 * release step into a brand-new run every time (ISS-669's re-run cascade).
 * Leaving the run open on `released` lets the release step run inside it;
 * the run closes when release finishes and sets `closed`.
 */
// cm:guard `dropped` closes the run like `closed` but must NEVER reach markMergedOnClose. Since 2026-08-25 dropping DOES release the dependents (owner's call), so this split is no longer what stops that — `drop-cascade.ts` expires the edges and records why on each dependent. What the split still stops is the shipped claim: `merged_at` means the code reached the base branch, a dropped issue's never did, and stamping it would make every downstream reader (release notes, the L2 gate's satisfied arm, pipeline-health) count work that does not exist.
export const RUN_CLOSING_STATUSES = new Set<IssueStatus>(['closed', 'dropped']);

/**
 * Who is performing the transition. `id` feeds the outbox actor context
 * (ISS-196 trigger attribution); the WS `actorId` is the user id for user
 * actors and the device owner for device actors.
 */

export type TransitionErrorCode =
  | 'NO_OP'
  | 'ILLEGAL_TRANSITION'
  | 'TRANSITION_REASON_REQUIRED'
  | 'WAITING_KIND_REQUIRED'
  | 'STALE_TRANSITION'
  | 'NO_WORK_EVIDENCE'
  | 'RELEASE_RECORD_REQUIRED';

/**
 * Typed transition failure. `message` keeps the legacy `CODE: detail` shape
 * the MCP surface exposes; REST callers map `code`/`detail`/`details` onto
 * HTTPException instead of parsing the string.
 */
export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    readonly detail: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${detail}`);
  }
}

export type TransitionIssueRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
};

type TransitionTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ApplyStatusTransitionOptions {
  beforeStatusWrite?: (tx: TransitionTx) => Promise<void>;
  /**
   * Bypass `canTransitionFree`. In practice that guard only forbids `draft`
   * as a target and restricts `draft`'s own exits, so this flag buys exactly
   * two things: entering `draft` (nothing does) and moving a `draft` issue to
   * a status outside {open, closed, developed}. The soft-skip resolver
   * (ISS-110) also passes it while walking `STAGE_FORWARD`.
   *
   * It is NOT a general safety override: NO_OP, stale-transition detection and
   * every content guard still run. The orchestrator is its caller.
   */
  skip?: boolean;
  /**
   * ISS-596 — operator/tooling unblock sentinel or human-supplied reason.
   * Carried as the `pipeline.reason` outbox session setting (so the
   * orchestrator can allow an `on_hold → *` transition from a non-user
   * actor without breaching the ISS-411 hard-stop) AND echoed on the WS
   * `issue.statusChanged` payload.
   */
  reason?: string | undefined;
  /**
   * Why the pipeline is being stopped, in the actor's own words. REQUIRED
   * entering `reopen`, `waiting` or `needs_info`; posted as a comment before
   * the status write.
   */
  // cm:guard required, not advisory (RFC 0002 INV-8) — every guard deleted with the reopen cap was an attempt to detect a missing rationale AFTER the fact, and each detected it by stranding the issue; rejecting the write is the only version that cannot strand anything
  transitionReason?: string | undefined;
  /**
   * Which flavour of "a human is needed" this park is. REQUIRED entering
   * `waiting`.
   */
  // cm:guard REQUIRED but never DEFAULTED (RFC 0002 INV-5) — refusing the write is not the same as picking a value: an unstated kind must never be guessed, because the five-way derivation this replaced guessed wrong on ISS-163 and rendered the wrong button
  waitingKind?: WaitingKind | undefined;
  /**
   * This close is the release itself, so it may write `closed` past the gate.
   */
  // cm:guard `release_batch finish` is the ONLY caller entitled to set this, and it must never be plumbed through a route parameter or an MCP argument — the flag IS the gate, and anything that can ask for it can close an unshipped issue
  viaReleasePath?: boolean;
}

export interface StatusTransitionResult {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  updatedAt: Date;
  /**
   * `toStatus` entered `TERMINAL_FOR_DISPATCH`. The Layer-2 dispatch fan-out
   * (`triggerTerminalDispatch`) is left to the caller so the batch route can
   * fan out once per request and programmatic callers can rely on the 60s
   * pg-boss backstop. The open run is closed separately, only when `toStatus`
   * is in `RUN_CLOSING_STATUSES` (ISS-669 — `released` no longer closes it).
   */
  terminal: boolean;
  /**
   * Dependents whose `blocks` edge this transition expired, collected before
   * the expiry ran. Non-empty only on a `dropped` transition. The caller hands
   * this to `triggerTerminalDispatch` — it cannot be re-derived, because every
   * dependent query filters expired edges out.
   */
  unblockedDependents: UnblockedDependent[];
}

/**
 * WS `issue.statusChanged` publish. The bus subscriber for `transition`
 * intentionally does NOT broadcast `issue.statusChanged` (see
 * `ws/broadcast-subscribers.ts:38`); writers must publish inline to avoid
 * double-emit on the single-issue path.
 */
export function publishIssueStatusChange(
  projectId: string,
  payload: {
    issueId: string;
    from: IssueStatus;
    to: IssueStatus;
    reopenCount: number;
    actorId: string;
    reason: string | null;
    at: Date;
  },
): void {
  roomManager.publish(projectRoom(projectId), {
    event: 'issue.statusChanged',
    data: payload,
  });
}

/**
 * ISS-787 — `draft` is the safe entry status you only get by remembering to
 * ask for it, and `open` (the default) auto-triages and spawns a pipeline run.
 * Three agents on three projects made that mistake, and `ILLEGAL_TRANSITION`
 * left them no way back: one parked at `on_hold`, another left the run going.
 *
 * So `draft` is reachable, but only while the mistake is still only a mistake:
 * nothing has run. A run or a job means work exists, and demoting to `draft`
 * would make the status claim the issue was never started.
 */
/** `null` when the counts could not be read — callers must treat that as "refuse". */
async function countRunsAndJobs(
  issueId: string,
): Promise<{ runCount: number; jobCount: number } | null> {
  try {
    const [[runRow], [jobRow]] = await Promise.all([
      db
        .select({ n: count() })
        .from(pipelineRuns)
        .where(eq(pipelineRuns.issueId, issueId))
        .limit(1),
      db.select({ n: count() }).from(jobs).where(eq(jobs.issueId, issueId)).limit(1),
    ]);
    return { runCount: Number(runRow?.n ?? 0), jobCount: Number(jobRow?.n ?? 0) };
  } catch (err) {
    logger.warn({ err, issueId }, 'draft-exemption check failed; refusing the transition');
    return null;
  }
}

async function assertIssueNeverEnteredPipeline(
  issueId: string,
  fromStatus: IssueStatus,
): Promise<void> {
  const refuse = (detail: string, details: Record<string, unknown>): never => {
    throw new TransitionError('ILLEGAL_TRANSITION', detail, {
      from: fromStatus,
      to: 'draft',
      ...details,
    });
  };

  const counts = await countRunsAndJobs(issueId);
  if (!counts) {
    // cm:guard this ONE guard fails CLOSED, unlike every sibling. Failing open here would GRANT the exemption on a database hiccup and demote an issue with real work to `draft` — a status that says nothing ever started. Refusing is also exactly the behaviour that shipped before this exemption existed, so an unavailable check costs nobody anything they had.
    return refuse(
      '`draft` is reachable only while the issue has never entered the pipeline, and that could not be checked just now. Retry, or use `on_hold` to pause active work.',
      { checkFailed: true },
    );
  }

  const { runCount, jobCount } = counts;
  if (runCount === 0 && jobCount === 0) return;
  return refuse(
    `\`draft\` is reachable only while the issue has never entered the pipeline; this one has ${runCount} pipeline run(s) and ${jobCount} job(s). Use \`on_hold\` to pause active work, or \`dropped\` to abandon it.`,
    { runCount, jobCount },
  );
}

/**
 * Two conditions share the `draft` UPDATE's WHERE — the status must still be
 * `fromStatus`, and the never-ran counts must still be zero — so a zero-row
 * result alone does not say which one bit. Re-read both and name the one that
 * did, rather than reporting a lost status race as a run appearing.
 */
async function explainDraftRace(
  issueId: string,
  fromStatus: IssueStatus,
  toStatus: IssueStatus,
): Promise<TransitionError> {
  const details = { from: fromStatus, to: toStatus, raced: true };
  const [[row], counts] = await Promise.all([
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1),
    countRunsAndJobs(issueId),
  ]);
  if (row && row.status !== fromStatus) {
    return new TransitionError(
      'STALE_TRANSITION',
      `issue status changed concurrently — it left \`${fromStatus}\` for \`${row.status}\` while this transition was being applied`,
      { ...details, observedStatus: row.status },
    );
  }
  if (counts && (counts.runCount > 0 || counts.jobCount > 0)) {
    return new TransitionError(
      'ILLEGAL_TRANSITION',
      `\`draft\` is reachable only while the issue has never entered the pipeline, and it acquired ${counts.runCount} pipeline run(s) and ${counts.jobCount} job(s) while this transition was being applied. Use \`on_hold\` to pause active work.`,
      { ...details, runCount: counts.runCount, jobCount: counts.jobCount },
    );
  }
  // cm:guard the fallback must name BOTH conditions, never guess one — the re-read is not in the failed UPDATE's transaction, so a value that raced back (a run cancelled and deleted, a status restored) leaves nothing to attribute it to, and naming the wrong one is the misdiagnosis ISS-787 exists to remove
  return new TransitionError(
    'ILLEGAL_TRANSITION',
    `the \`draft\` transition from \`${fromStatus}\` did not apply, and re-reading found neither a status change nor a pipeline run/job to attribute it to. Retry; if it refuses again, use \`on_hold\` to pause active work.`,
    { ...details, attributable: false },
  );
}

/**
 * THE issue state-machine writer. Every surface — REST `/transition`,
 * REST `PATCH /batch`, MCP `forge_issues`, orchestrator soft-skip,
 * reconciler, finalize-failure — routes through here so
 * guard semantics, the conditional UPDATE, `merged_at` stamping, WS
 * broadcast, pipeline-health refresh and run close cannot drift apart.
 *
 * Throws `TransitionError` (NO_OP / ILLEGAL_TRANSITION /
 * REOPEN_REASON_REQUIRED / STALE_TRANSITION / PLAN_REQUIRED); callers map it
 * onto their own error surface.
 */
export async function transitionIssueStatus(
  issue: TransitionIssueRow,
  requestedStatus: IssueStatus,
  actor: TransitionActor,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  const fromStatus = issue.status;
  if (fromStatus === requestedStatus) {
    throw new TransitionError('NO_OP', `issue already in status ${requestedStatus}`, {
      status: fromStatus,
    });
  }

  // cm:guard `skip` bypasses this whole check ON PURPOSE — it is the orchestrator's curated soft-skip chain, and every other runtime transition is deliberately permissive because the system prompt, not this function, guides the happy path
  if (!options.skip && !canTransitionFree(fromStatus, requestedStatus)) {
    if (requestedStatus === 'draft') {
      await assertIssueNeverEnteredPipeline(issue.id, fromStatus);
    } else {
      // cm:guard reaching here means fromStatus is `draft` — once the target is not `draft`, canTransitionFree fails for no other reason — so blame the SOURCE, never the target. The old wording said `'<target>' is not a valid runtime status target`, which is false for every status it ever named: walking ISS-787's AC6 hit it on `needs_info` and on `waiting`, both legal from everywhere except `draft`, and it reads as "that status was removed".
      throw new TransitionError(
        'ILLEGAL_TRANSITION',
        `a \`draft\` issue may only move to ${DRAFT_EXIT_TARGETS.map((s) => `\`${s}\``).join(', ')}. \`${requestedStatus}\` is a legal target from every other status, but not from \`draft\` — promote it to \`open\` first, or use \`dropped\` to discard it.`,
        { from: fromStatus, to: requestedStatus, allowedFromDraft: [...DRAFT_EXIT_TARGETS] },
      );
    }
  }

  // cm:guard the reason is posted BEFORE the status write, and a failed post must reject the whole transition — a park that commits without its reason is the unexplained park every guard deleted with the reopen cap tried to detect afterwards
  // cm:guard `skip: true` is exempt ON PURPOSE — it marks a transition the system made rather than one an actor chose (the park rewrites), and each of those paths posts its own comment; requiring a second one would double-comment, and refusing the write would freeze the cascade mid-flight
  if (requiresAuthoredReason(fromStatus, requestedStatus) && options.skip !== true) {
    const reason = options.transitionReason?.trim();
    if (!reason) {
      throw new TransitionError(
        'TRANSITION_REASON_REQUIRED',
        `a transition to \`${requestedStatus}\` must carry a reason saying what is needed or what is wrong`,
        { from: fromStatus, to: requestedStatus },
      );
    }
    if (requestedStatus === 'waiting' && !options.waitingKind) {
      throw new TransitionError(
        'WAITING_KIND_REQUIRED',
        'a `waiting` park must say which kind it is: `needs_decision` or `needs_resource`',
        { from: fromStatus, to: requestedStatus },
      );
    }
  }

  const reopening = isReopenEntry(fromStatus, requestedStatus);

  // cm:guard everything ABOVE this line reads `requestedStatus` (what the caller asked for) and everything BELOW writes `toStatus` (what the kernel will store); mixing the two either drops the park's reason, kind and counter or drops the rewrite, and each failure is silent
  const parkTarget = await resolveAutonomousParkTarget({
    projectId: issue.projectId,
    requested: requestedStatus,
    agency: actorAgency(actor),
  });
  const { status: toStatus, held } = await resolveAgentCloseTarget({
    projectId: issue.projectId,
    requested: parkTarget,
    agency: actorAgency(actor),
    viaReleasePath: options.viaReleasePath === true,
  });
  if (fromStatus === toStatus) {
    throw new TransitionError('NO_OP', `issue already in status ${toStatus}`, {
      status: fromStatus,
      requested: requestedStatus,
    });
  }

  // cm:guard reads `toStatus`, never `requestedStatus` — an agent close that resolveAgentCloseTarget rewrote to the release gate is not making the shipped claim, and refusing it there would park the session at a status it cannot leave
  const unrecorded = await refuseUnrecordedClose(issue.id, toStatus, actor, options);
  if (unrecorded) {
    throw new TransitionError('RELEASE_RECORD_REQUIRED', unrecorded.detail, unrecorded.details);
  }

  const txResult = await executeTransitionWrite({
    issue,
    fromStatus,
    requestedStatus,
    toStatus,
    actor,
    options,
    reopening,
  });
  const updated = txResult.row;

  publishIssueStatusChange(issue.projectId, {
    issueId: updated.id,
    from: fromStatus,
    to: toStatus,
    reopenCount: updated.reopenCount,
    actorId: actor.type === 'user' ? actor.id : actor.ownerId,
    reason: options.reason ?? null,
    at: updated.updatedAt,
  });

  // Audit trail for the close-time stamp: only fires when the close is what
  // stamped merged_at (hand/MCP closes of never-merged issues — the pipeline
  // path stamped earlier on leaving the base merge state, so it stays quiet).
  // Best-effort: the transition already committed; losing the comment must
  // not fail the caller.
  if (held) {
    try {
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: actor.type === 'user' ? actor.id : actor.ownerId,
        body: `Held at the release gate — merged, not shipped. \`merged_at\` is stamped, so every \`blocks\`-dependent can dispatch now; the issue closes when a release ships it.`,
        parentId: null,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id },
        'transition: release-gate hold comment failed (transition already committed)',
      );
    }
  }

  if (txResult?.stampedOnClose && !held) {
    try {
      // ISS-786 child B, requirement 5 — name whether any code evidence
      // exists so a false unblock (ISS-75/76/77/78 shape) becomes visible
      // instead of silent. Best-effort: a read failure here must not change
      // the comment into a false-negative claim, so it falls back to the
      // evidence-exists text (unmark is still the correct remedy either way).
      const evidenceFound = await collectWorkEvidence(issue.id)
        .then(hasCodeEvidence)
        .catch(() => true);
      const evidenceNote = evidenceFound
        ? 'If this issue was abandoned (its code never landed on the base branch), run `forge_issues` `unmark` to re-block dependents.'
        : 'No branch, commit or code handoff is recorded for this issue — if its code never landed, run `forge_issues` `unmark` to re-block dependents.';
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: actor.type === 'user' ? actor.id : actor.ownerId,
        body: `merged_at auto-stamped on close — \`closed\` counts as done, so \`blocks\`-dependents can now dispatch. ${evidenceNote}`,
        parentId: null,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id },
        'transition: close-stamp audit comment failed (transition already committed)',
      );
    }
  }

  if (txResult && txResult.unblockedDependents.length > 0) {
    await recordDropUnblock(issue, txResult.unblockedDependents, actor);
  }

  // ISS-164 — refresh derived pipelineHealth (stage mirrors issues.status).
  await publishPipelineHealthChanged(issue.projectId, [updated.id]);

  // ISS-101 — keep run timeline in sync with issue status, then close it on
  // RUN_CLOSING_STATUSES entries. No-ops when no open run exists (e.g. an
  // issue that transitions before any job is queued).
  await setCurrentStepForOpenIssueRun(issue.id, toStatus);
  // cm:guard a held close is terminal FOR DISPATCH even though the status is not: `merged_at` is stamped, so the L2 blocks gate is satisfied and the dependents are ready now — leaving this false makes them wait for the 60s reconciler backstop instead of the fan-out
  const terminal = TERMINAL_FOR_DISPATCH.has(toStatus) || held;
  // cm:guard the run must close on a hold too. The driver's session is over; a run left `running` while the issue waits days for a release is the state-never-lies breach the gate exists to fix, and the loop monitor would eventually reap it as a stall.
  if (RUN_CLOSING_STATUSES.has(toStatus) || held) {
    await closeOpenRunForIssue(issue.id, 'completed');
  }

  return {
    id: updated.id,
    status: updated.status as IssueStatus,
    reopenCount: updated.reopenCount,
    updatedAt: updated.updatedAt,
    terminal,
    unblockedDependents: txResult?.unblockedDependents ?? [],
  };
}

type TransitionWriteInput = {
  issue: TransitionIssueRow;
  fromStatus: IssueStatus;
  requestedStatus: IssueStatus;
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: ApplyStatusTransitionOptions;
  reopening: boolean;
};

type TransitionWriteResult = {
  row: { id: string; status: IssueStatus; reopenCount: number; updatedAt: Date };
  stampedOnClose: boolean;
  unblockedDependents: UnblockedDependent[];
};

async function executeTransitionWrite(input: TransitionWriteInput): Promise<TransitionWriteResult> {
  const { issue, fromStatus, requestedStatus, toStatus, actor, options, reopening } = input;
  // cm:guard the never-ran check is re-asserted IN the UPDATE's WHERE, not just read above it — a freshly-`open` issue acquires its run within seconds, so a count read a moment earlier can hand `draft` to an issue that is already working, and the status would then claim nothing had started
  const draftGate =
    toStatus === 'draft' && !options.skip
      ? [
          sql`not exists (select 1 from pipeline_runs pr where pr.issue_id = ${issue.id}) and not exists (select 1 from jobs j where j.issue_id = ${issue.id})`,
        ]
      : [];
  try {
    return await db.transaction(async (tx) => {
      await options.beforeStatusWrite?.(tx);
      if (requiresAuthoredReason(fromStatus, requestedStatus) && options.skip !== true) {
        await postTransitionReasonComment(
          {
            issueId: issue.id,
            authorId: actor.type === 'user' ? actor.id : actor.ownerId,
            fromStatus,
            toStatus: requestedStatus,
            reason: options.transitionReason?.trim() ?? '',
            waitingKind: options.waitingKind ?? null,
          },
          tx,
        );
      }
      const violation = await checkTransitionEvidence({
        issue: { id: issue.id, projectId: issue.projectId },
        toStatus: requestedStatus,
        agency: actorAgency(actor),
        skip: options.skip === true,
        executor: tx,
      });
      if (violation) throw new TransitionError(violation.code, violation.detail, violation.details);
      // cm:flow dispatch/transition — the status UPDATE commits and an AFTER UPDATE trigger enqueues the outbox row in this same transaction
      // cm:guard the UPDATE below must stay conditional on the CURRENT status, or two concurrent transitions both win and the loser's status is silently overwritten
      // cm:edge sideeffect -> packages/core/drizzle/migrations/0070_pipeline_outbox.sql — trg_issues_status_outbox fires on this UPDATE and writes pipeline_outbox; no call site references it, so a reader of this file cannot see the row being produced
      const result = await withActorContext(
        tx,
        { type: actor.type, id: actor.id },
        options.reason ?? null,
        async (t) => {
          const [row] = await t
            .update(issues)
            .set({
              status: toStatus,
              reopenCount: reopening ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
              // cm:guard the CLEAR arm is the load-bearing half — a kind left behind on an issue that has moved on renders a live "a human is needed" banner on work already in flight, and nothing else in the system would ever clear it
              waitingKind: toStatus === 'waiting' ? (options.waitingKind ?? null) : null,
              updatedAt: sql`now()`,
            })
            .where(and(eq(issues.id, issue.id), eq(issues.status, fromStatus), ...draftGate))
            .returning({
              id: issues.id,
              status: issues.status,
              reopenCount: issues.reopenCount,
              updatedAt: issues.updatedAt,
            });
          if (!row) return null;
          await markMergedIfLeavingBase(t, {
            issueId: issue.id,
            projectId: issue.projectId,
            fromStatus,
            toStatus,
          });
          const closeStamp = await markMergedOnClose(t, {
            issueId: issue.id,
            toStatus: requestedStatus,
          });
          const unblockedDependents =
            toStatus === 'dropped'
              ? await expireBlocksEdgesOnDrop(t, issue.projectId, issue.id)
              : [];
          return { row, stampedOnClose: closeStamp.stamped, unblockedDependents };
        },
      );
      // cm:guard throw a stale transition inside this transaction — combined update callbacks may already have written fields and relations, so returning from the callback would commit a mutation whose caller was told it failed
      if (!result)
        throw new TransitionError('STALE_TRANSITION', 'issue status changed concurrently', {
          from: fromStatus,
          to: toStatus,
        });
      return result;
    });
  } catch (error) {
    if (error instanceof TransitionError && error.code === 'STALE_TRANSITION' && draftGate.length) {
      throw await explainDraftRace(issue.id, fromStatus, toStatus);
    }
    throw error;
  }
}

/**
 * Device-actor convenience wrapper used by MCP tools and pipeline internals
 * (orchestrator, reconciler, finalize-failure, runs-control).
 * Same semantics as `transitionIssueStatus`; failures surface as
 * `TransitionError` (an `Error` with the legacy `CODE: detail` message) so
 * MCP tool handlers can wrap them uniformly.
 */
export async function applyStatusTransition(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  device: DeviceLite,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  return transitionIssueStatus(issue, toStatus, { type: 'device', ...device }, options);
}
