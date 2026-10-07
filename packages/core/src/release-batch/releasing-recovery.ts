import { REDACTED, redactedMessage, redactQueryParams } from '@forge/observability';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { comments, type IssueStatus, issues, projects } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { ISSUE_STATUS_LABELS } from '../issues/status-sets.js';
import {
  pgBoundValues,
  pgDriverError,
  pgErrorClassDescription,
  pgObjectNames,
} from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { ReleaseFinishFenceLostError } from './errors.js';
import { RELEASE_GATE_STATUS, resolveReleaseGate } from './gate.js';

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
  | { kind: 'refused'; code: string; detail: string; blocking: string[] }
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

export function closeRefusalOf(err: unknown): CloseRefusal {
  if (err instanceof TransitionError) {
    return {
      kind: 'refused',
      code: err.code,
      detail: err.detail,
      blocking: blockingObjects(err.details),
    };
  }
  return { kind: 'failed', message: failureMessage(err) };
}

/**
 * A close that failed short of a decision, in words that never carry the statement or a value bound
 * to it (ISS-1381 r2).
 */
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
 * text, so where the query-error seal cut a bound value out of one (`gj_[Redacted]_needs_ledger`)
 * it is put back whole — only where the message quotes it after the word Postgres names that kind
 * of object by (`constraint "…"`), only where no other name was cut alike, and never where the whole
 * name is a bound value. A bound value left outside those names, or a reason withheld whole, falls
 * back to what the SQLSTATE's class means (ISS-1381 r3).
 */
function databaseReason(err: unknown, driver: { code: string; message: string }): string {
  const values = pgBoundValues(err);
  const objects = pgObjectNames(err).filter(({ name }) => !values.includes(name));
  const cut = new Map(objects.map(({ name }) => [name, redactQueryParams(`"${name}"`, err)]));
  const quoted = (words: readonly string[], name: string) => words.map((w) => `${w} "${name}"`);
  let reason = redactQueryParams(driver.message);
  for (const { words, name } of objects) {
    const form = cut.get(name) ?? '';
    const alike = [...cut.values()].filter((other) => other === form).length;
    if (form === `"${name}"` || alike > 1) continue;
    for (const w of words) reason = reason.split(`${w} ${form}`).join(`${w} "${name}"`);
  }
  const outsideNames = objects
    .flatMap(({ words, name }) => quoted(words, name))
    .reduce((text, occurrence) => text.split(occurrence).join(''), reason);
  const leaks = values.some((v) => outsideNames.includes(v));
  if (leaks || outsideNames.trim() === REDACTED) return pgErrorClassDescription(driver.code);
  return reason.split(REDACTED).join(WITHHELD_VALUE);
}

/** What a finish reports for one issue it could not close, on its answer and its record. */
export function closeFailureText(refusal: CloseRefusal): string {
  return refusal.kind === 'refused' ? `${refusal.code}: ${refusal.detail}` : refusal.message;
}

/**
 * What clears a refusal, as an act the issue's page offers at the release gate; a code with none
 * keeps its own detail. No act there moves the issue to Closed or withdraws a question (ISS-1381 r3).
 */
function personClears(refusal: Extract<CloseRefusal, { kind: 'refused' }>): string {
  switch (refusal.code) {
    case 'OPEN_QUESTIONS':
      return 'answer each open question in its "Decision waiting" card on this issue\'s page.';
    case 'CLOSE_REQUIRES_SHIPPED':
      return 'mark the issue merged on its Properties rail, naming where its work landed.';
    case 'STALE_TRANSITION':
      return 'nothing; the issue changed while the release was closing it. Read where it stands now.';
    default:
      return refusal.detail;
  }
}

/** Where a returned issue stands and how it closes, in the words its page uses. */
function howItCloses(destination: IssueStatus, once: string): string {
  const label = ISSUE_STATUS_LABELS[destination];
  if (destination !== RELEASE_GATE_STATUS) {
    return `The issue is at ${label}, and a person decides whether it goes back to work or into another release.`;
  }
  return (
    `The issue is back at ${label} and its code is live with that release. ${once}, the release ` +
    'banner on this page offers Release now, which starts a release that closes it; or leave it ' +
    'there and the next release closes it.'
  );
}

/** What a finish that shipped tells an issue it could not close, and how that issue closes later. */
export function refusedCloseComment(args: {
  refusal: CloseRefusal;
  projectId: string;
  version: string | null;
  destination: IssueStatus;
  /** How a roster its run promoted is settled; such an issue stays claimed rather than moving. */
  held?: string | undefined;
}): string {
  const { refusal, version, destination, held } = args;
  const shipped = version ? `as version ${version}` : 'with this batch';
  const why =
    refusal.kind === 'refused'
      ? `The close was refused with \`${refusal.code}\`. ${
          refusal.blocking.length > 0
            ? `Blocking it: ${refusal.blocking.join(', ')}.`
            : 'The refusal named no blocking object.'
        } What clears it: ${personClears(refusal)}`
      : `The close failed before it reached a decision: ${refusal.message}. Nothing on this issue refused it, so nothing here is yours to clear: that reason is for whoever operates this Forge to fix.`;
  const opening = `The release finished and shipped ${shipped}, but this issue could not be closed. ${why}\n\n`;
  if (held) {
    const again = refusal.kind === 'refused' ? 'refused' : 'failed';
    return `${opening}${held} Clear the reason above first, or that close is ${again} again.`;
  }
  const once =
    refusal.kind === 'refused' ? 'Once the reason above is cleared' : 'Once that is fixed';
  return opening + howItCloses(destination, once);
}

export interface RecoverStrandedReleasingOptions {
  /** Written onto the issue as the reason, and into a comment when an author is known. */
  reason: string;
  /** The person who caused this, when there is one. Absent for a machine sweep. */
  actorUserId?: string | undefined;
  /** Who the comments are written as where no person caused this, such as a device's owner. */
  commentAuthorId?: string | undefined;
  /** Post a comment naming the reason. Off for a sweep nobody asked for. */
  comment?: boolean;
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
      projectCreatedBy: projects.createdBy,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.releaseBatchRunId, runId));

  const alreadyClosed = claimed.filter((r) => r.status === 'closed').map((r) => r.id);
  const promoted = await runRecordedPromotion(runId);
  if (promoted && options.settlePromotedRoster !== true) {
    logger.warn(
      { runId, claimed: claimed.length, reason: options.reason },
      'release-batch: this run promoted, so its roster stays at `releasing` for a person to settle',
    );
    await noteOnRoster(claimed, options, promotedNote(runId));
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

  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;

    const author = options.actorUserId ?? options.commentAuthorId;
    if (options.comment && author) {
      const refusal = options.refusals?.get(issue.id);
      try {
        await db.insert(comments).values({
          issueId: issue.id,
          authorId: author,
          body: refusal
            ? refusedCloseComment({
                refusal,
                projectId: issue.projectId,
                version: options.version ?? null,
                destination,
              })
            : promoted
              ? `${options.reason}. ${settledNote(issue.projectId, destination)}`
              : `${options.reason}. The issue is at \`${destination}\` — a person decides whether it goes back to work or into another batch.`,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: recovery comment failed');
      }
    }

    const fallbackId = issue.projectCreatedBy ?? issue.projectId;
    const actor: TransitionActor = options.actorUserId
      ? { type: 'user', id: options.actorUserId }
      : { type: 'device', id: fallbackId, ownerId: fallbackId };

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
      'release-batch: issues rescued from `releasing` by a batch that wrote no outcome',
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
function settledNote(projectId: string, destination: IssueStatus): string {
  return (
    `This batch recorded a promotion, so the code it carried may be on production, and an operator ` +
    `settled the roster rather than leave it at \`releasing\` — the issue is back at ` +
    `\`${destination}\`. If the release did land, record it with ` +
    `POST /api/projects/${projectId}/release-records, naming the commit production is serving and ` +
    `how it was released; that closes it against evidence instead of by hand.`
  );
}

function promotedNote(runId: string): (projectId: string) => string {
  return (projectId) =>
    `This batch recorded a promotion, so its issues stay at \`releasing\` and stay claimed: the code may be on production, and no other status here would be safe to claim. No screen settles a promoted roster yet, so settling it is an operator's act. Read the run with \`GET /api/projects/${projectId}/release-batches/${runId}/state\`. To settle the issues, abort the batch with POST /api/projects/${projectId}/release-batches/${runId}/abort and a body of {"promotedRoster":"return-to-gate"}, which puts them back at the release gate, and then, if the release did land, record it with POST /api/projects/${projectId}/release-records; or settle each issue by hand.`;
}

/**
 * Say on each issue what happened, without moving it.
 */
async function noteOnRoster(
  claimed: Array<{ id: string; status: string; projectId: string }>,
  options: RecoverStrandedReleasingOptions,
  note: (projectId: string) => string,
): Promise<void> {
  const author = options.actorUserId ?? options.commentAuthorId;
  if (!options.comment || !author) return;
  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;
    const refusal = options.refusals?.get(issue.id);
    try {
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: author,
        body: refusal
          ? refusedCloseComment({
              refusal,
              projectId: issue.projectId,
              version: options.version ?? null,
              destination: 'releasing',
              held: note(issue.projectId),
            })
          : `${options.reason}. ${note(issue.projectId)}`,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, 'release-batch: promotion note failed');
    }
  }
}
