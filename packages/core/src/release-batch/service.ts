// create: opens a system run, atomically claims N gate-status issues, moves each
// to `releasing`, enqueues one release_batch job. finish: closes every claimed
// issue and completes the run. abort: cancels the run and every job under it
// and closes no issue.
//
// Both outcomes take the run terminal, and by different outcomes: `completed`
// for a finish, `cancelled` for an abort. That is what stops
// `getActiveReleaseBatch` answering a batch whose work is over, and what
// keeps a finish from reading like an abort.
//
// finish and abort are the only writers that leave `releasing`. Both hand the
// claim release to `releasing-recovery.ts`, which is also what a batch that
// died without either outcome goes through.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  issues,
  jobs,
  type PipelineRunStatus,
  pipelineRuns,
} from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { issuesMissingReleaseRecord } from '../issues/release-record-required.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import { cancelConcludedRun, closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { readProjectBranches } from '../projects/service.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import { resolveReleaseChannels, resolveReleaseDeviceIds, resolveReleasePlan } from './channel.js';
import { resolveReleaseGate } from './gate.js';
import { assertMethodFor, readMethod } from './method.js';
import { RELEASE_BATCH_SKILL, ReleaseBranchesUndeclaredError, releaseBranches } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';
import { readLiveCommit, verifyDeployed } from './verify.js';

export { ReleaseBranchesUndeclaredError };

export class NoReleaseGateError extends Error {
  constructor() {
    super('NO_RELEASE_GATE');
    this.name = 'NoReleaseGateError';
  }
}

/**
 * The project named a release pool and no runner is in it. Distinct from
 * `NoRunnerOnlineError` on purpose: "nobody is online" and "the box that holds
 * the deploy credential lost its label" need different remedies.
 */
export class ReleasePoolEmptyError extends Error {
  constructor(public readonly label: string) {
    super('RELEASE_POOL_EMPTY');
    this.name = 'ReleasePoolEmptyError';
  }
}

/**
 * The project declares a release model but no live deploy binding names a release runner. Rule
 * 3 of ISS-897: a gate without a designated box is a refusal, never a fallback.
 */
export class ReleaseRunnerUndeclaredError extends Error {
  constructor() {
    super('RELEASE_RUNNER_UNDECLARED');
    this.name = 'ReleaseRunnerUndeclaredError';
  }
}

/**
 * The project has more than one live deploy channel, and a run can prove only one.
 *
 * ISS-1046 widened what core RETURNS from one live binding to the whole live SET, which is the
 * right answer to "where does this project release to". It did NOT widen the attempt ledger:
 * `commitBefore` is one string on the run, `readLiveState` reads one channel's probes, and
 * `finishReleaseBatch` closes the whole roster on that single reading. So a two-endpoint release
 * would be verified at one endpoint and closed for both — the quietest possible way to claim a
 * ship nobody checked.
 *
 * It refuses instead. Measured over the fleet at the 0253 cutover: of the 12 projects carrying a
 * live deploy binding, zero carry two, so this refuses nothing anyone does today and stands
 * between the first operator who adds a second one and a silently half-verified release. The way
 * out is per-binding verification, which is its own piece of work:
 * `docs/proposals/release-verifies-one-endpoint.md`.
 */
export class ReleaseMultiChannelUnsupportedError extends Error {
  readonly code = 'RELEASE_MULTI_CHANNEL_UNSUPPORTED';
  constructor(readonly count: number) {
    super(
      `RELEASE_MULTI_CHANNEL_UNSUPPORTED: this project declares ${count} live deploy bindings, and a release run records ONE reading — one \`commitBefore\`, one set of probes, one verdict — which would be taken at one of them and used to close the whole roster. Core will not claim a release it verified at one endpoint of two. Leave exactly one binding carrying the \`live\` stage active, or release them as separate projects.`,
    );
    this.name = 'ReleaseMultiChannelUnsupportedError';
  }
}

/**
 * The project declares a release gate and no verification probes, so nothing
 * but the agent's own word could say the release happened.
 */
// cm:guard the gate and the probes are ONE declaration, refused together. `finish` is the only thing in Forge that writes `closed`, and with no probes its whole verification block was skipped — sid-desk ISS-191 is 42 issues closed on a release that was not running. Refusing at creation is what makes the operator declare probes instead of discovering at close time that nothing checked. `finish` refuses too, and must: a run created before this rule existed reaches it with no probes and would close its roster on the agent's word.
export class ReleaseProbesUndeclaredError extends Error {
  constructor() {
    super('RELEASE_PROBES_UNDECLARED');
    this.name = 'ReleaseProbesUndeclaredError';
  }
}

export class NoRunnerOnlineError extends Error {
  constructor() {
    super('NO_RUNNER_ONLINE');
    this.name = 'NoRunnerOnlineError';
  }
}

/**
 * The probes did not agree that the release is live. `finish` refuses, so the
 * agent's only remaining move is `abort` — which is the point.
 */
export class ReleaseNotVerifiedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly live: string | null,
  ) {
    super('RELEASE_NOT_VERIFIED');
    this.name = 'ReleaseNotVerifiedError';
  }
}

/**
 * `finish` was called on a run somebody aborted.
 */
// cm:guard refused BY NAME and never answered with an empty success. ISS-1032's own guard states the rule this completes: `completed` and never "terminal", because a silent empty success on a `cancelled` run makes finish and abort report the same thing. Before ISS-1042's abort cancelled a concluded run, this case fell through to the probes and came back RELEASE_NOT_VERIFIED — a sentence about the deploy for a condition that is about the batch having been called off, which sends an agent to production over a decision a person already took.
export class ReleaseBatchAbortedError extends Error {
  constructor() {
    super('RELEASE_BATCH_ABORTED');
    this.name = 'ReleaseBatchAbortedError';
  }
}

export class ClaimConflictError extends Error {
  constructor(public readonly issueIds: string[]) {
    super('CLAIM_CONFLICT');
    this.name = 'ClaimConflictError';
  }
}

/**
 * One or more issues in the batch have no release note, so the batch would
 * close them claiming a ship nobody wrote anything about.
 */
// cm:guard distinct from ClaimConflictError ON PURPOSE — "wrong status or already claimed" and "nothing written about what shipped" need different remedies, and folding the second into the first is how a caller retries forever against an error that will never clear on its own
export class ReleaseRecordMissingError extends Error {
  constructor(public readonly issueIds: string[]) {
    super(`RELEASE_RECORD_MISSING: ${issueIds.length} issue(s) have no release note`);
    this.name = 'ReleaseRecordMissingError';
  }
}

export class BatchInFlightError extends Error {
  constructor(public readonly existingJobId: string | null) {
    super('BATCH_IN_FLIGHT');
    this.name = 'BatchInFlightError';
  }
}

export interface CreateReleaseBatchArgs {
  projectId: string;
  issueIds: string[];
  userId: string;
}

export interface CreateReleaseBatchResult {
  runId: string;
  jobId: string;
  issueIds: string[];
  gateStatus: IssueStatus;
}

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
): Promise<CreateReleaseBatchResult> {
  const { projectId, issueIds, userId } = args;

  const gateStatus = await resolveReleaseGate(projectId);
  if (!gateStatus) throw new NoReleaseGateError();

  const preflightRows = await db
    .select({ id: issues.id, status: issues.status, releaseBatchRunId: issues.releaseBatchRunId })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));

  const foundIds = new Set(preflightRows.map((r) => r.id));
  const notFound = issueIds.filter((id) => !foundIds.has(id));
  if (notFound.length > 0) throw new ClaimConflictError(notFound);

  const notClaimable = preflightRows.filter(
    (r) => r.status !== gateStatus || r.releaseBatchRunId !== null,
  );
  if (notClaimable.length > 0) throw new ClaimConflictError(notClaimable.map((r) => r.id));

  // cm:guard refuse at the CLAIM, not at the close. `finish` closes with `viaReleasePath`, which the release-record refusal exempts, so this preflight IS that exemption's justification — ISS-863's own evidence row is a batch that closed two issues whose releaseNotes was null. Refusing here strands nothing: nothing has moved yet, no run is open and no issue is claimed.
  // cm:edge lockstep -> packages/core/src/issues/release-record-required.ts — one rule, two doors. That module exempts `viaReleasePath` BECAUSE of this line; delete it and the batch path silently closes unrecorded issues again.
  const unrecorded = await issuesMissingReleaseRecord(issueIds);
  if (unrecorded.length > 0) throw new ReleaseRecordMissingError(unrecorded);

  const plan = await resolveReleasePlan(projectId);
  // cm:guard a gated project MUST name its release runner, and an undeclared label refuses here rather than widening to the fleet. The pool exists because one box holds the production credential; `allowDeviceIds: null` means "anyone", and a release that lands on a box without that credential fails halfway through with the merge already pushed. Measured 2026-09-03: 0 of 20 active prod bindings carried `releaseRunnerLabel`, so this refusal is what makes the operator declare one instead of discovering the gap mid-deploy.
  if (!plan.releaseRunnerLabel) throw new ReleaseRunnerUndeclaredError();
  // cm:edge lockstep -> packages/core/src/release-batch/service.ts finishReleaseBatch — the same refusal stands at the close, and deleting either half puts back the path where a project with no probes closes its roster on a sentence an agent wrote.
  // cm:guard EVERY channel owes probes, not just the first: `resolveReleaseChannels` returns the whole live set (ISS-1046) and the agent works all of it, so a set where one member declares none is a release one of whose endpoints nothing can prove.
  if (plan.channels.some((c) => !c.verify)) throw new ReleaseProbesUndeclaredError();
  const allowDeviceIds = await resolveReleaseDeviceIds(projectId, plan.releaseRunnerLabel);
  if (allowDeviceIds.length === 0) {
    throw new ReleasePoolEmptyError(plan.releaseRunnerLabel);
  }

  // cm:guard this asks LIVENESS, never routing — it must stay a count, because the box that ends up running the batch is whichever master claims it, and a preflight that named a device here would be predicting a decision core no longer makes. `allowDeviceIds` still narrows it: the question is "is anyone in the release pool alive", not "who".
  const releasePool = await onlineCapableDeviceIds(projectId, {}, { allowDeviceIds });
  if (releasePool.length === 0) throw new NoRunnerOnlineError();

  const project = (await readProjectBranches(projectId)) ?? {
    baseBranch: null,
    liveBranch: null,
    releaseModel: 'none' as const,
    releaseStrategy: null,
  };
  const { baseBranch, liveBranch, promotePlanned } = releaseBranches(project, project.releaseModel);
  // cm:guard `deployPlanned` names the CHANNEL, not the branches. It used to mean "the branches differ", which reported a planned deploy to every project that promotes across branches and deploys nothing — and a planned deploy that cannot happen is the kind of claim this whole gate exists to remove.
  const deployPlanned = plan.channels.length > 0;

  // cm:guard read the live commit BEFORE anything moves. Without this baseline a release that deployed nothing verifies perfectly: the probes answer, the commit matches what the agent reports, and what it reports is what was already serving.
  // cm:guard the set is refused above 1 rather than collapsed to its first member. The commit-before
  // is one string on the run and `finish` closes the whole roster on one reading, so `channels[0]`
  // would verify one endpoint and claim two. A loud break beats a silent substitution.
  if (plan.channels.length > 1) throw new ReleaseMultiChannelUnsupportedError(plan.channels.length);
  const firstVerify = plan.channels[0]?.verify ?? null;
  const commitBefore = firstVerify ? await readLiveCommit(firstVerify) : null;

  const run = await openOneShotRun({
    projectId,
    kind: 'system',
    metadata: {
      source: 'release-batch',
      gateStatus,
      issueIds,
      deployPlanned,
      promotePlanned,
      commitBefore,
    },
  });

  // cm:edge protocol -> packages/core/src/release-batch/routes.ts — this CAS UPDATE is the sole claim authority; issues.metadata is never used as a lock (see schema.ts guard)
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE issues
    SET release_batch_run_id = ${run.id}, updated_at = now()
    WHERE project_id = ${projectId}
      AND id IN (${sql.join(
        issueIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND status = ${gateStatus}
      AND release_batch_run_id IS NULL
    RETURNING id
  `);

  if (claimed.length !== issueIds.length) {
    await closeRunIfOneShot(run.id, 'cancelled');
    throw new ClaimConflictError(issueIds.filter((id) => !claimed.some((r) => r.id === id)));
  }

  // cm:guard the status moves with the CLAIM, so "a release is running over this issue" is readable from `status` and not only from a column join. Before this the issue stood at the gate status for the whole batch and `releasing` did not exist, so one status meant both "waiting to be pressed" and "being released now" — 16 batch runs, 4 failed and 2 cancelled, are the cases where those diverge.
  // cm:guard `viaReleasePath` is required here for the same reason `finish` needs it: `release-gate-hold.ts` rewrites any other actor's move off the gate status back to it, so a claim without it would be undone by the hold on the next read.
  for (const id of claimed.map((r) => r.id)) {
    try {
      await transitionIssueStatus(
        { id, projectId, status: gateStatus, reopenCount: 0 },
        'releasing',
        { type: 'user', id: userId },
        { viaReleasePath: true },
      );
    } catch (err) {
      if (!(err instanceof TransitionError && err.code === 'NO_OP')) {
        logger.warn({ err, issueId: id, runId: run.id }, 'release-batch: could not mark releasing');
      }
    }
  }

  const issueRows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, title: issues.title })
    .from(issues)
    .where(inArray(issues.id, issueIds));

  const batchPrefix = await activeIssuePrefix(projectId);
  const promptString = buildReleaseBatchPrompt({
    runId: run.id,
    projectId,
    baseBranch,
    liveBranch,
    releaseModel: project.releaseModel,
    releaseStrategy: project.releaseStrategy,
    plan,
    issues: issueRows.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? formatIssueRef(batchPrefix, r.issSeq) : r.id,
      title: r.title ?? '(untitled)',
    })),
  });

  let jobId: string;
  try {
    const result = await insertAndEnqueueJob({
      projectId,
      issueId: null,
      pipelineRunId: run.id,
      createdBy: userId,
      type: 'release_batch',
      // cm:edge lockstep -> packages/core/src/release-batch/prompt.ts — the prompt emits the invocation line off this SAME constant. A literal here is how the job comes to name one skill while the prompt asks for another, which is the state ISS-1042 found: the column said `release-flow` and nothing in the prompt, the runner or the plugin ever read it.
      skillName: RELEASE_BATCH_SKILL,
      promptString,
      payloadExtras: {
        releaseBatch: true,
        gateStatus,
        issueIds,
        timeoutSeconds: 3600,
      },
    });
    jobId = result.jobId;
  } catch (err) {
    if (err instanceof ActiveJobConflictError) {
      // cm:guard the claims were taken AND every issue was already moved to `releasing` above, so a bare clear here leaves the whole roster mid-release under a run that never got a job — recover them before the run closes, while the claim column can still find them.
      await recoverStrandedReleasing(run.id, {
        reason: 'another batch was already in flight, so this one never started',
        actorUserId: userId,
      });
      await closeRunIfOneShot(run.id, 'cancelled');
      throw new BatchInFlightError(err.existingJobId);
    }
    throw err;
  }

  return { runId: run.id, jobId, issueIds, gateStatus };
}

export interface FinishReleaseBatchResult {
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
}

export interface FinishReleaseBatchOptions {
  /** The commit the release says it pushed, for the probes to match against. */
  commit?: string | undefined;
}

export async function finishReleaseBatch(
  runId: string,
  actor: TransitionActor,
  options: FinishReleaseBatchOptions = {},
): Promise<FinishReleaseBatchResult> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
      status: pipelineRuns.status,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);

  // cm:guard read BEFORE the probes, which the retry guard below needs, and the roster this read
  // carries is safe to close from even though `verifyDeployed` may wait tens of seconds on it. The
  // close is `transitionIssueStatus`, whose UPDATE is conditional on the snapshot's own
  // `fromStatus` (`apply-transition.ts:executeTransitionWrite`), so an issue a concurrent
  // `abortReleaseBatch` moved to `reopen` in that window matches no row and raises
  // `STALE_TRANSITION` into `failed[]` — it is never closed out from under the abort.
  // `recoverStrandedReleasing` then skips it, because it acts only on issues still at `releasing`,
  // and `closeRunIfOneShot` matches only `running|paused`, so the abort's `cancelled` stands. The
  // race therefore moves no state either way; what it changes is that finish now NAMES the
  // concurrency in `failed[]` instead of returning an empty result, which is the account the abort
  // guard below wanted when batch ee39c4ae closed 0 of 12 in silence.
  const claimed = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

  // cm:guard BOTH halves, and neither alone. A finish this function already ran is a run at
  // `completed` WITH no claim left on it — `recoverStrandedReleasing` clears
  // `release_batch_run_id` for the whole run — and it must answer without probing again: the probes
  // read the world now, not then, so a release verified an hour ago fails its second read the
  // moment the site restarts, sits behind a cache, or moves past the window in which it still
  // serves that commit, and the caller is handed `RELEASE_NOT_VERIFIED` about a release that
  // demonstrably landed. That is the same false account of a succeeded batch that ISS-1032 exists
  // to remove. On the status alone this would swallow a finish it never ran: `reapConcludedRuns`
  // closes a `running` run `completed` once its last job is `done` and an hour has passed, so a
  // batch whose release job ended without anyone calling `finish` reaches exactly that status with
  // every issue still claimed at `releasing` — and an empty success there would strand the whole
  // roster with nothing left to find it by. On the claim set alone it would skip the close that is
  // this issue's entire fix. `completed` and never "terminal": a `cancelled` run is an ABORTED
  // batch, and a silent empty success on one would make the two verbs report the same thing.
  if (run?.status === 'completed' && claimed.length === 0) return { closed: [], failed: [] };

  // cm:guard a `cancelled` run is an ABORTED batch and the refusal has to say so. It cannot share
  // the empty success above — that answer means "this finish already ran" — and it must not fall
  // through to the probes, which would answer RELEASE_NOT_VERIFIED about a release nobody is
  // attempting any more. The abort already returned the roster and released the claims; what is
  // left to tell the caller is that its own abort stands.
  if (run?.status === 'cancelled') throw new ReleaseBatchAbortedError();

  if (run) {
    // cm:guard the expected skill is read off the RUN'S OWN JOB and never off `RELEASE_BATCH_SKILL`
    // directly: a run cut before the constant last moved is still working from the skill its job
    // named, and comparing it to today's constant would refuse a release for having been dispatched
    // last week. The job is the record of what this run was asked to run.
    // cm:edge lockstep -> packages/core/src/release-batch/method.ts — `assertMethodFor` is the
    // predicate and this is its one caller. An announcement whose `loaded` is false passes on
    // purpose; the guard there prices that amnesty.
    // cm:why `skillName` is a key of `jobs.payload` and not a column of `jobs` — `insertAndEnqueueJob` writes it into the payload jsonb beside `promptString`, and `feedback_reports.skill_name` is a different field about a different thing.
    const [job] = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(and(eq(jobs.pipelineRunId, runId), eq(jobs.type, 'release_batch')))
      .orderBy(desc(jobs.queuedAt))
      .limit(1);
    const jobSkill = (job?.payload as { skillName?: unknown } | null)?.skillName;
    assertMethodFor(
      readMethod(run.metadata),
      typeof jobSkill === 'string' && jobSkill.length > 0 ? jobSkill : RELEASE_BATCH_SKILL,
    );

    const channels = await resolveReleaseChannels(run.projectId);
    // cm:guard `if (channel.verify)` used to wrap the whole block, so a project declaring no probes fell straight through to the closes — the shape this issue is named for. It is a REFUSAL now and not a skip: an unverifiable release is not a verified one, and the operator's way out is to declare probes or abort.
    const closeVerify = channels[0]?.verify ?? null;
    if (channels.length === 0 || channels.some((c) => !c.verify) || !closeVerify) {
      throw new ReleaseProbesUndeclaredError();
    }
    const meta = (run.metadata ?? {}) as Record<string, unknown>;
    const outcome = await verifyDeployed({
      cfg: closeVerify,
      commitBefore: typeof meta.commitBefore === 'string' ? meta.commitBefore : null,
      expected: options.commit ?? null,
    });
    // cm:guard refuse BEFORE closing anything. A partial close would leave some issues claiming a release the probes just said did not happen, and nothing walks that back.
    if (!outcome.ok) throw new ReleaseNotVerifiedError(outcome.reason, outcome.live);
  }

  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const issue of claimed) {
    try {
      await transitionIssueStatus(
        {
          id: issue.id,
          projectId: issue.projectId,
          status: issue.status,
          reopenCount: issue.reopenCount,
        },
        'closed',
        actor,
        // cm:edge protocol -> packages/core/src/issues/release-gate-hold.ts — the ONLY caller allowed to pass this. It is what makes `finish` the single writer of `closed` past the gate; an agent's own close is rewritten back to the gate without it
        { viaReleasePath: true },
      );
      closed.push(issue.id);
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'NO_OP') {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: failed to close issue');
        failed.push({ id: issue.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // cm:guard clearing the claims is not enough on its own: an issue this loop could NOT close is still at `releasing`, and the column being cleared is what makes it unreachable afterwards. The recovery lands those at `reopen` with the reason, and touches nothing it already closed.
  await recoverStrandedReleasing(runId, {
    reason: 'the release finished but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
  });

  // cm:guard `completed` and never `failed`, INCLUDING when `failed` is non-empty. `getActiveReleaseBatch` reads `running|paused`, so a finish that left the run non-terminal answered its own runId forever and refused the next cut 409 BATCH_IN_FLIGHT until a person aborted a batch that had already shipped (ISS-1032; SidPeak held 4h19m on 2026-09-15). `cancelled` would collapse finish into abort, and either non-success outcome makes the cascade cancel the still-active `release_batch` job — the job whose own session is what CALLED this — with `failureKind: 'infra'` and a kill broadcast at it, which is ISS-352's false-failed badge over a release that did land. The price of that, taken deliberately: `pipeline_runs.status` alone no longer separates a clean finish from a partial one — both read `completed`, and a reader wanting the difference must go to the response's `failed[]`, to each stranded issue sitting at `reopen`, or to the comment `recoverStrandedReleasing` writes above. The alternative was a run row that tells the truth about the roster by lying about the release, and it costs a live session its process. The trade ends when something needs the distinction FROM the run row; nothing reads it that way today.
  await closeRunIfOneShot(runId, 'completed');

  return { closed, failed };
}

export interface AbortReleaseBatchResult {
  claimsCleared: string[];
  /** Where the roster went, or `null` when nothing moved. */
  destination: IssueStatus | null;
  /** True when the run had promoted, so the roster stayed at `releasing`. */
  promoted: boolean;
  /** What the abort did to the run row, in its own words. */
  run: {
    status: PipelineRunStatus | null;
    wasAlreadyTerminal: boolean;
    cancelledFrom: PipelineRunStatus | null;
  };
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
): Promise<AbortReleaseBatchResult> {
  // cm:guard an aborted release does NOT self-heal, which is the trade this takes deliberately: a half-landed batch re-driven automatically becomes two half-landed batches. Before this the abort cleared the column and left the status untouched, so a failed release was indistinguishable from one never attempted. It goes through the shared recovery so an abort and a batch that merely died reach the same place by the same writer — and since ISS-1042 that place is chosen by whether the run PROMOTED, not by which verb called.
  const { claimsCleared, destination, promoted } = await recoverStrandedReleasing(runId, {
    reason: `batch release aborted: ${reason}`,
    actorUserId,
    comment: true,
  });

  // cm:guard abort is "nothing under this run executes any further", not just "no claims" — batch ee39c4ae (2026-09-03) was aborted while its retry job kept running, shipped 20 commits to production, then `finish` found no claims and closed 0 of 12; the run must go terminal here so the cascade cancels queued retries and kills the live session
  await closeRunIfOneShot(runId, 'cancelled');

  // cm:guard `closeRunIfOneShot` matches `running|paused` ONLY, so an abort arriving after anything else concluded the run wrote nothing and SAID nothing: the row went on reading `completed` about a batch somebody had called off and the caller was handed a plain success. Routed here from ISS-1032 because this issue owns "a release run cannot lie" — the second call is what makes the row agree with the verb, and the result below is what makes the caller able to tell the two cases apart.
  const after = await cancelConcludedRun(runId);

  return {
    claimsCleared,
    destination,
    promoted,
    run: {
      status: after.cancelled ? 'cancelled' : after.was,
      wasAlreadyTerminal: after.cancelled,
      cancelledFrom: after.cancelled ? after.was : null,
    },
  };
}

// cm:edge naming -> packages/core/src/release-batch/queries.ts — every caller imports the batch surface from this module; the read-only half lives next door for the size budget, and re-exporting keeps that a file layout rather than an API change
export {
  type ActiveReleaseBatchInfo,
  findReleaseBatchRun,
  getActiveReleaseBatch,
  isOpenReleaseBatchRun,
  loadReleaseBatchContext,
  loadReleaseRoster,
  type ReleaseBatchContext,
  type ReleaseBatchIssue,
  type ReleaseRoster,
  type ReleaseRosterEntry,
} from './queries.js';
