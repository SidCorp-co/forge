import { REDACTED, redactedMessage, redactQueryParams } from '@forge/observability';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { forgeActor, forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { statusLabel } from '../issues/status-sets.js';
import {
  pgBoundValues,
  pgDriverError,
  pgErrorClassDescription,
  pgObjectNames,
} from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { namesNoRepository } from '../projects/live-source.js';
import { sayCloseFailure } from './close-failures.js';
import { ReleaseFinishFenceLostError } from './errors.js';
import { resolveReleaseGate } from './gate.js';
import { type RunDelivery, reasonSentence, refusedCloseComment } from './refused-close-words.js';

export interface RecoverStrandedReleasingResult {
  /** Issues whose claim was cleared, closed ones included: the claim is a lock, not a status. */
  claimsCleared: string[];
  /** Claimed issues already `closed` when the roster was read: a finish closed them, and they stay. */
  alreadyClosed: string[];
  /** Issues that were still at `releasing` and were moved off it. */
  recovered: string[];
  /** Where the recovered issues went, or `null` when nothing moved. */
  destination: IssueStatus | null;
  /** True when the run recorded a promotion. On its own it does not say the roster stayed put:
   *  `settlePromotedRoster` settles one anyway, and `destination` is what moved. */
  promoted: boolean;
}

/**
 * Did this run put anything on production?
 *
 * A `promote` attempt EXISTS is the question, not whether it succeeded: an act
 * that was declared and never reported back is exactly the one that may have
 * landed, and reading an unsettled promotion as "nothing happened" is how a
 * roster gets walked back over code that is serving.
 */
export async function runRecordedPromotion(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: releaseAttempts.id })
    .from(releaseAttempts)
    .where(and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.stage, 'promote')))
    .limit(1);
  return row !== undefined;
}

/** What this run's promotions and deploys reported, each declared before it was made (`ledger.ts`).
 *  Only one that reported going out lets a finish say the code went out: declared and never settled,
 *  or settled as failed, is not one (ISS-1421 r41, r42). `runRecordedPromotion` keeps counting an
 *  unsettled promotion, because it decides whether a roster is held, not what a comment claims. */
export async function runDelivery(runId: string): Promise<RunDelivery> {
  const rows = await db
    .select({ settledAt: releaseAttempts.settledAt, verdict: releaseAttempts.verdict })
    .from(releaseAttempts)
    .where(
      and(eq(releaseAttempts.runId, runId), inArray(releaseAttempts.stage, ['promote', 'deploy'])),
    );
  if (rows.length === 0) return 'none';
  return rows.some((r) => r.settledAt !== null && r.verdict !== null && r.verdict !== 'failed')
    ? 'reported'
    : 'unreported';
}

/** The issues still claimed by `runId` that are `closed`: what its finish closed and nothing moved. */
export async function closedOnRoster(runId: string, executor: Tx = db): Promise<string[]> {
  const rows = await executor
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.releaseBatchRunId, runId), eq(issues.status, 'closed')));
  return rows.map((r) => r.id);
}

/** Why a finish could not close one issue: a refusal the transition named, or a failure that never
 *  reached a decision (ISS-1381). */
export type CloseRefusal =
  | {
      kind: 'refused';
      code: string;
      detail: string;
      blocking: string[];
      steps: string[];
      /** The refusal named a lane outside git, whose mark names where the work is, not a commit. */
      outsideGit: boolean;
    }
  | { kind: 'failed'; message: string };

/** `openQuestionIds` → `open question`: the label each id in that collection is named by. */
function blockerLabel(key: string): string {
  return key
    .replace(/Ids$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/** Every id a refusal's details name, in key order, so a second collection needs no new case. */
function blockingObjects(details: Record<string, unknown>): string[] {
  return Object.keys(details)
    .filter((key) => key.endsWith('Ids') && Array.isArray(details[key]))
    .sort()
    .flatMap((key) =>
      (details[key] as unknown[])
        .filter((id): id is string => typeof id === 'string')
        .map((id) => `${blockerLabel(key)} ${id}`),
    );
}

/** An agent's step for each record a refusal names, from `details.steps` (ISS-1421 r16). */
function stepsOf(steps: unknown): string[] {
  if (!steps || typeof steps !== 'object') return [];
  return Object.values(steps).filter((s): s is string => typeof s === 'string');
}

export function closeRefusalOf(err: unknown): CloseRefusal {
  if (err instanceof TransitionError) {
    return {
      kind: 'refused',
      code: err.code,
      detail: err.detail,
      blocking: blockingObjects(err.details),
      steps: stepsOf(err.details.steps),
      outsideGit: err.details.shape === 'outside_git',
    };
  }
  return { kind: 'failed', message: failureMessage(err) };
}

/** A close that failed short of a decision, without its statement or a bound value (ISS-1381 r2). */
function failureMessage(err: unknown): string {
  const driver = pgDriverError(err);
  if (driver) {
    return `the database refused the write (${driver.code}): ${databaseReason(err, driver)}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('Failed query:')) return 'a database query failed without saying why';
  return redactedMessage(err);
}

/** What stands in a reason where a value of the write was cut out of it. */
const WITHHELD_VALUE = '(a value of this write, withheld)';

/**
 * The database's own reason, read with no bound value in it. A schema object's name is the schema's
 * text, so one the query-error seal cut a bound value out of (`gj_[Redacted]_needs_ledger`) is
 * named whole. It goes back in place only in Postgres's own integrity message (class 23), which
 * quotes its constraint once, after `constraint `, and only where that cut stands once: anywhere
 * else the cut may be a different quote sealed alike, so the name is named beside the reason. A
 * name that is a bound value stays out. A bound value left outside those names, or a reason
 * withheld whole, falls back to what the SQLSTATE's class means (ISS-1381 r3, r4).
 */
function databaseReason(err: unknown, driver: { code: string; message: string }): string {
  const values = pgBoundValues(err);
  const objects = pgObjectNames(err).filter(({ name }) => !values.includes(name));
  const reason = redactQueryParams(driver.message);
  const outsideNames = objects.reduce((text, { name }) => text.split(`"${name}"`).join(''), reason);
  const leaks = values.some((v) => outsideNames.includes(v));
  if (leaks || outsideNames.trim() === REDACTED) return pgErrorClassDescription(driver.code);
  const sealed = (name: string) => redactQueryParams(`"${name}"`, err);
  const cut = objects.filter(({ name }) => sealed(name) !== `"${name}"`);
  const inPlace = cut.filter(
    ({ kind, name }) =>
      driver.code.startsWith('23') &&
      kind === 'constraint' &&
      reason.split(sealed(name)).length === 2 &&
      reason.includes(`constraint ${sealed(name)}`),
  );
  const restored = inPlace.reduce(
    (text, { name }) => text.split(sealed(name)).join(`"${name}"`),
    reason,
  );
  const readable = restored.split(REDACTED).join(WITHHELD_VALUE);
  const beside = cut
    .filter((o) => !inPlace.includes(o))
    .map(({ kind, name }) => `${kind} "${name}"`);
  return beside.length > 0 ? `${readable} (the database names ${beside.join(', ')})` : readable;
}

/** What a finish reports for one issue it could not close, on its answer and its record. */
export function closeFailureText(refusal: CloseRefusal): string {
  if (refusal.kind !== 'refused') return refusal.message;
  return [`${refusal.code}: ${refusal.detail}`, ...refusal.steps].join('\n');
}

/** The account a comment about this move is written as: a person's own, a device's owner's. */
function authorOf(actor: TransitionActor): string {
  return actor.type === 'user' ? actor.id : actor.ownerId;
}

export interface RecoverStrandedReleasingOptions {
  /** Written onto the issue as the reason, and into a comment when an author is known. */
  reason: string;
  /** Who caused this, when someone did: the moves are theirs, and so are the comments (a device's
   *  are its owner's) unless `commentsByForge` says otherwise. Absent for a sweep, which acts and
   *  writes as Forge. */
  actor?: TransitionActor | undefined;
  /** Post a comment naming the reason. Off for a sweep nobody asked for. */
  comment?: boolean;
  /** Forge writes the comments while the moves stay the actor's: an abort's words are Forge's, and
   *  they name the person who pressed it (ISS-1421 r42). */
  commentsByForge?: boolean;
  /** The one next step an unpromoted hand-back's comment ends on, in place of the general one, by
   *  where the issue now stands (ISS-1421 r6: one comment, one next step). */
  nextStep?: ((at: IssueStatus) => string) | undefined;
  /** Why the finish could not close each issue, by id; such an issue's comment names it. */
  refusals?: ReadonlyMap<string, CloseRefusal> | undefined;
  /** The version the finish shipped, named in a refused issue's comment. */
  version?: string | null | undefined;
  /** Settle a roster whose run promoted instead of holding it — a person's word and never a
   *  sweep's, buying a batch that promoted and cannot verify a status some door closes from
   *  (ISS-1199). */
  settlePromotedRoster?: boolean;
  /** Run inside each write's own transaction before it writes; throws to stop the recovery. */
  fence?: ((tx: Tx) => Promise<void>) | undefined;
}

/**
 * Release every claim on `runId` and rescue whatever it left mid-release.
 *
 * Ordered recover-then-clear: the claim column is the only index onto the
 * batch's issues, so clearing first leaves nothing to read them back by.
 */
export async function recoverStrandedReleasing(
  runId: string,
  options: RecoverStrandedReleasingOptions,
): Promise<RecoverStrandedReleasingResult> {
  const claimed = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

  const alreadyClosed = claimed.filter((r) => r.status === 'closed').map((r) => r.id);
  const promoted = await runRecordedPromotion(runId);
  if (promoted && options.settlePromotedRoster !== true) {
    logger.warn(
      { runId, claimed: claimed.length, reason: options.reason },
      'release-batch: this run promoted, so its roster stays at Releasing until the releasing sweep settles it',
    );
    await noteOnRoster(runId, claimed, options, PROMOTED_NOTE);
    return {
      claimsCleared: [],
      alreadyClosed,
      recovered: [],
      destination: null,
      promoted: true,
    };
  }

  const gateStatus = claimed[0] ? await resolveReleaseGate(claimed[0].projectId) : null;
  const destination: IssueStatus = gateStatus ?? 'reopen';

  const recovered: string[] = [];
  const actor = options.actor ?? (await forgeActor(db));
  const author = await commentAuthor(actor, options);
  const said = await refusalContext(runId, claimed[0]?.projectId, options);

  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;

    if (options.comment) {
      const refusal = options.refusals?.get(issue.id);
      try {
        if (refusal) {
          await sayRefusedClose(runId, issue, author, refusal, options, (repeats) =>
            refusedCloseComment({
              refusal,
              projectId: issue.projectId,
              version: options.version ?? null,
              destination,
              repeats,
              marked: issue.mergedAt !== null,
              ...said,
            }),
          );
        } else {
          await postSystemComment({
            issueId: issue.id,
            authorId: author,
            body: promoted
              ? `${reasonSentence(options.reason)} ${settledNote(destination)}`
              : `${reasonSentence(options.reason)} The issue is at ${statusLabel(destination)}. ${
                  options.nextStep?.(destination) ??
                  'A person decides whether it goes back to work or into another release.'
                }`,
          });
        }
      } catch (err) {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: recovery comment failed');
      }
    }

    try {
      await transitionIssueStatus(
        {
          id: issue.id,
          projectId: issue.projectId,
          status: issue.status,
          reopenCount: issue.reopenCount,
        },
        destination,
        actor,
        {
          transitionReason: options.reason,
          viaReleasePath: true,
          ...(options.fence ? { beforeStatusWrite: options.fence } : {}),
        },
      );
      recovered.push(issue.id);
    } catch (err) {
      if (err instanceof ReleaseFinishFenceLostError) throw err;
      if (!(err instanceof TransitionError && err.code === 'NO_OP')) {
        logger.warn(
          { err, issueId: issue.id, runId },
          'release-batch: could not recover a stranded releasing issue',
        );
      }
    }
  }

  const { fence } = options;
  const released = await db.transaction(async (tx) => {
    if (fence) await fence(tx);
    return releaseClaims(tx, runId);
  });

  if (recovered.length > 0) {
    logger.warn(
      { runId, recovered: recovered.length, reason: options.reason },
      'release-batch: issues rescued from Releasing by a batch that wrote no outcome',
    );
  }

  // `promoted` and not `false`: a settled roster still came off a run that put
  // code on production, and this is the one fact the path exists to keep true.
  return {
    claimsCleared: released.cleared,
    alreadyClosed: released.closed,
    recovered,
    destination: recovered.length > 0 ? destination : null,
    promoted,
  };
}

/** Release every claim on `runId`, and in the same transaction add the closed ones to the run's
 *  `metadata.rosterClosed`: without the claim, that is the only record this batch closed them. */
async function releaseClaims(
  tx: Tx,
  runId: string,
): Promise<{ cleared: string[]; closed: string[] }> {
  const rows = await tx.execute<{ id: string; status: string }>(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${runId}
    RETURNING id, status
  `);
  const closed = rows.filter((r) => r.status === 'closed').map((r) => r.id);
  if (closed.length > 0) {
    await tx.execute(sql`
      UPDATE pipeline_runs
      SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{rosterClosed}', (
            SELECT jsonb_agg(DISTINCT id) FROM jsonb_array_elements_text(
              coalesce(metadata -> 'rosterClosed', '[]'::jsonb) || ${JSON.stringify(closed)}::jsonb
            ) AS t(id))),
          updated_at = now()
      WHERE id = ${runId}
    `);
  }
  return { cleared: rows.map((r) => r.id), closed };
}

/** What a roster is told when an operator settles it although this run promoted. */
function settledNote(destination: IssueStatus): string {
  return (
    `This batch recorded a promotion, so the code it carried may be on production, and an operator ` +
    `settled the roster rather than leave it at Releasing — the issue is back at ` +
    `${statusLabel(destination)}. If the release did land, record that release, naming the commit ` +
    `production is serving and how it was released; that closes it against evidence instead of by hand.`
  );
}

const PROMOTED_NOTE =
  "This batch recorded a promotion, so the code it carried may be on production, and its issues stay at Releasing and claimed while its run is live. Once the run has ended, Forge's releasing sweep settles them within a minute: it reads what production serves, closes through a release record each issue whose landing commit production carries, and returns the rest to the release gate. View release on the issue shows where its run stands.";

/** What a refused issue's comment says beside its refusal, read once per roster and only where a
 *  refusal is there to say it: what the run's promotions and deploys reported, and whether a mark
 *  may name no commit. */
async function refusalContext(
  runId: string,
  projectId: string | undefined,
  options: RecoverStrandedReleasingOptions,
): Promise<{ delivery: RunDelivery; noRepository: boolean }> {
  const refusals = [...(options.refusals?.values() ?? [])];
  if (refusals.length === 0 || !projectId) return { delivery: 'none', noRepository: false };
  const delivery = await runDelivery(runId);
  const unmarked = refusals.some(
    (r) => r.kind === 'refused' && r.code === 'CLOSE_REQUIRES_SHIPPED',
  );
  const noRepository = unmarked && (await namesNoRepository(projectId));
  return { delivery, noRepository };
}

/** Who a hand-back's comments are written as: the actor, a device's owner, or Forge. */
async function commentAuthor(
  actor: TransitionActor,
  options: RecoverStrandedReleasingOptions,
): Promise<string> {
  return options.commentsByForge ? forgeAuthorId(db) : authorOf(actor);
}

function sayRefusedClose(
  runId: string,
  issue: { id: string; projectId: string },
  authorId: string,
  refusal: CloseRefusal,
  options: RecoverStrandedReleasingOptions,
  body: (repeats: ReadonlyArray<string | null>) => string,
): Promise<void> {
  return sayCloseFailure({
    runId,
    projectId: issue.projectId,
    issueId: issue.id,
    authorId,
    kind: refusal.kind,
    reason: closeFailureText(refusal),
    version: options.version ?? null,
    body,
  });
}

/**
 * Say on each issue what happened, without moving it.
 */
async function noteOnRoster(
  runId: string,
  claimed: Array<{ id: string; status: string; projectId: string; mergedAt: Date | null }>,
  options: RecoverStrandedReleasingOptions,
  note: string,
): Promise<void> {
  if (!options.comment) return;
  const author = await commentAuthor(options.actor ?? (await forgeActor(db)), options);
  const said = await refusalContext(runId, claimed[0]?.projectId, options);
  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;
    const refusal = options.refusals?.get(issue.id);
    try {
      if (refusal) {
        await sayRefusedClose(runId, issue, author, refusal, options, (repeats) =>
          refusedCloseComment({
            refusal,
            projectId: issue.projectId,
            version: options.version ?? null,
            destination: 'releasing',
            held: note,
            repeats,
            marked: issue.mergedAt !== null,
            ...said,
          }),
        );
      } else {
        await postSystemComment({
          issueId: issue.id,
          authorId: author,
          body: `${reasonSentence(options.reason)} ${note}`,
        });
      }
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, 'release-batch: promotion note failed');
    }
  }
}
