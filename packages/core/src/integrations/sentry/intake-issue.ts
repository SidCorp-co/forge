/**
 * ISS-1085 slice 4 — the decision ONE Sentry issue gets, whichever door it arrived by.
 *
 * Split out of `intake.ts` when the webhook became a second caller. Everything here is about a
 * single Sentry issue and a single Forge row; `intake.ts` keeps what only a scheduled pull has,
 * which is targets, pages, a report and a `schedule_runs` outcome. There is one implementation and
 * two callers, because two copies of lookup-then-judge-and-file would drift with nothing saying so
 * — a threshold honoured on one door and not the other reads exactly like a gate that ran.
 *
 * The lookup comes BEFORE the admission gate, and the chokepoint against untrusted Sentry text is
 * described where it is decided: `intake.ts`'s header, and `SentryIssueDetail` in `types.ts`. The
 * defence this file owns is structural — `buildSentryIssueRow` returns a closed shape whose
 * `status` is the literal `draft`, and the one status this module moves is decided by the
 * `substatus` enum rather than by any text a payload carried.
 */

import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { comments, issues } from '../../db/schema.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import { logger } from '../../logger.js';
import { judgeSentryIssue, type SentryAdmissionThresholds } from './admission.js';
import type { SentryIssueDetail } from './types.js';

/** The status a Sentry issue is filed at, and the only one this path ever writes on a create. */
export const SENTRY_FILED_STATUS = 'draft' as const;
/** The `issues.source` value this path writes. */
export const SENTRY_ISSUE_SOURCE = 'sentry' as const;
/**
 * The Sentry substatus that means an error somebody had resolved is happening again.
 *
 * Structural, which is why acting on it does not breach the rule that Sentry text never decides an
 * action: this is an enum Sentry computes, not a string an event carried.
 */
export const SENTRY_REGRESSED_SUBSTATUS = 'regressed';

const TITLE_CAP = 200;

/** What `issues.metadata.sentry` holds, and the only key of that metadata this path writes. */
export interface SentrySightingRecord {
  shortId: string;
  count: number | null;
  userCount: number | null;
  lastSeen: string | null;
  permalink: string | null;
  seenAt: string;
  /** Set where THIS sighting carried no event count and the one above was carried forward. */
  countMissingAt?: string;
}

/**
 * The row a filed Sentry issue becomes — a CLOSED shape, and that is the point.
 *
 * There is no `priority`, no `category` and no label here, so no amount of Sentry text can reach
 * one: the columns those would be take their own defaults. `status` is a literal.
 */
export interface SentryIssueRow {
  title: string;
  description: string;
  status: typeof SENTRY_FILED_STATUS;
  source: typeof SENTRY_ISSUE_SOURCE;
  externalId: string;
  detectorKey: string;
}

/** Everything one intake decision needs that is not the Sentry issue itself. */
export interface SentryIntakeContext {
  projectId: string;
  /** The Forge user a filed issue and a reopen are attributed to (`projects.createdBy`). */
  createdById: string;
  thresholds: SentryAdmissionThresholds;
  /** The declared target this issue was confined to, named in the filed issue's body. */
  target: { label: string; organizationSlug: string; projectSlug?: string };
}

/**
 * What one intake decision did, in the vocabulary both doors report in.
 *
 * `refused` carries its own sentence rather than a code: the pull writes it into the schedule run's
 * output and the webhook onto its delivery row, and in both places a person reading it has to be
 * able to fix the cause without opening the source.
 */
export type SentryIntakeOutcome =
  | { kind: 'filed' }
  | { kind: 'commented' }
  | { kind: 'refreshed' }
  | { kind: 'reopened' }
  | { kind: 'refused'; reason: string };

/** Bound a TITLE, which is a column a person scans. Never used for the run's own record. */
function capTitle(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The title and body a Sentry issue becomes.
 *
 * Both fields are already `sanitizeUntrusted`-stripped by `issues.ts:projectIssue`. The title is
 * capped because it is a column a person scans, and the structural fields (counts, timestamps,
 * permalink) are written by this code from typed values rather than copied out of free text.
 */
export function buildSentryIssueRow(
  issue: SentryIssueDetail,
  externalId: string,
  detectorKey: string,
  target: { label: string; organizationSlug: string; projectSlug?: string },
): SentryIssueRow {
  const headline = issue.title?.trim() ? issue.title.trim() : `Sentry issue ${externalId}`;
  const lines = [
    `Filed from Sentry issue \`${externalId}\` on target **${target.label}** (org \`${target.organizationSlug}\`${target.projectSlug ? `, project \`${target.projectSlug}\`` : ''}).`,
    '',
    `- Level: ${issue.level ?? 'unknown'}`,
    `- Events: ${issue.count ?? 'not reported'}`,
    `- Users affected: ${issue.userCount ?? 'not reported'}`,
    `- First seen: ${issue.firstSeen ?? 'not reported'}`,
    `- Last seen: ${issue.lastSeen ?? 'not reported'}`,
    ...(issue.permalink ? [`- Sentry: ${issue.permalink}`] : []),
    '',
    '## Culprit',
    '',
    issue.culprit?.trim() ? issue.culprit : '_Sentry reported none._',
    '',
    '## Message',
    '',
    issue.metadataValue?.trim() ? issue.metadataValue : '_Sentry reported none._',
  ];
  return {
    title: capTitle(headline, TITLE_CAP),
    description: lines.join('\n'),
    status: SENTRY_FILED_STATUS,
    source: SENTRY_ISSUE_SOURCE,
    externalId,
    detectorKey,
  };
}

/**
 * The jsonb a re-sighting writes — a MERGE, never a replacement.
 *
 * cm:guard postgres's `||` on jsonb merges at the TOP level, so `metadata.sentry` is replaced and
 * every other key an issue's metadata holds — `branchConfig` among them — survives untouched. A
 * `.set({ metadata: <whole object> })` would be the `wholesale-config-clobber` this repo names as a
 * red flag: it would wipe every key this path did not resend. Exported so the SQL that reaches
 * postgres is asserted as text rather than described in a comment.
 */
export function sentryMetadataMerge(record: SentrySightingRecord): SQL {
  return sql`coalesce(${issues.metadata}, '{}'::jsonb) || ${JSON.stringify({ sentry: record })}::jsonb`;
}

/**
 * What this sighting records, keeping the last KNOWN count where this one carries none.
 *
 * cm:guard `previous` is what the growth test compares against, so writing a null over an
 * established count does not merely lose a number — it makes the NEXT real count look like a first
 * observation, and an increase from 17 to 41 then passes in silence because 17 is no longer there
 * to have been exceeded. A missing reading is a gap in what Sentry told us, never evidence that the
 * count went away, so the last known value is carried forward and the gap is recorded beside it.
 */
export function sighting(
  issue: SentryIssueDetail,
  shortId: string,
  previous: SentrySightingRecord | null,
): SentrySightingRecord {
  return {
    shortId,
    count: issue.count ?? previous?.count ?? null,
    userCount: issue.userCount ?? previous?.userCount ?? null,
    lastSeen: issue.lastSeen ?? previous?.lastSeen ?? null,
    permalink: issue.permalink ?? previous?.permalink ?? null,
    seenAt: new Date().toISOString(),
    ...(issue.count === null ? { countMissingAt: new Date().toISOString() } : {}),
  };
}

/** The whole sighting the last observation stored, or `null` where none was ever stored. */
export function recordedSighting(
  metadata: Record<string, unknown> | null,
): SentrySightingRecord | null {
  const entry = (metadata?.sentry ?? null) as SentrySightingRecord | null;
  return entry && typeof entry === 'object' ? entry : null;
}

/** The event count the last sighting recorded, or `null` where none was ever recorded. */
export function recordedCount(metadata: Record<string, unknown> | null): number | null {
  const entry = (metadata?.sentry ?? null) as { count?: unknown } | null;
  if (!entry || typeof entry.count !== 'number') return null;
  return entry.count;
}

interface ExistingIssue {
  id: string;
  projectId: string;
  status: string;
  reopenCount: number;
  metadata: Record<string, unknown> | null;
}

async function findFiled(projectId: string, externalId: string): Promise<ExistingIssue | null> {
  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      metadata: issues.metadata,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.source, SENTRY_ISSUE_SOURCE),
        eq(issues.externalId, externalId),
      ),
    )
    .limit(1);
  return row
    ? {
        id: row.id,
        projectId: row.projectId,
        status: row.status as string,
        reopenCount: row.reopenCount,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      }
    : null;
}

/**
 * An error that is already work: refresh what we know, and say so ONLY where something moved.
 *
 * A comment on every tick is how an operator-facing signal becomes noise they filter out, so the
 * comment is conditional on the event count having grown. The metadata is written either way —
 * `lastSeen` moving is worth recording and is not worth interrupting anybody for.
 */
async function observe(
  existing: ExistingIssue,
  issue: SentryIssueDetail,
  shortId: string,
  authorId: string,
): Promise<'commented' | 'refreshed'> {
  // cm:guard ONE transaction, and the row is re-read inside it UNDER A LOCK. These are two writes and exactly one comment is owed, which neither ordering of two independent statements can promise: whichever goes first, a failure between them is either a note nobody ever gets or a note everybody gets twice, and two deliveries overlapping read the same baseline and both comment. The lock is what makes the baseline this observation compares against the one no other observer can still be holding. `existing.metadata` from the pre-gate lookup is deliberately NOT reused here — it was read outside this transaction and may already be stale.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: issues.metadata })
      .from(issues)
      .where(eq(issues.id, existing.id))
      .for('update')
      .limit(1);
    const previous = recordedSighting((locked?.metadata ?? null) as Record<string, unknown> | null);
    const previousCount = previous?.count ?? null;
    const grew = issue.count !== null && previousCount !== null && issue.count > previousCount;

    if (grew) {
      await tx.insert(comments).values({
        issueId: existing.id,
        authorId,
        body: [
          `Sentry has seen \`${shortId}\` again.`,
          '',
          `- Events: ${issue.count} (was ${previousCount})`,
          `- Users affected: ${issue.userCount ?? 'not reported'}`,
          `- Last seen: ${issue.lastSeen ?? 'not reported'}`,
          ...(issue.permalink ? ['', issue.permalink] : []),
        ].join('\n'),
      });
    }

    await tx
      .update(issues)
      .set({ metadata: sentryMetadataMerge(sighting(issue, shortId, previous)) })
      .where(eq(issues.id, existing.id));

    return grew ? 'commented' : 'refreshed';
  });
}

/**
 * File one Sentry issue as a Forge issue, or report that one already held the key.
 *
 * `ON CONFLICT DO NOTHING` on the partial unique index is the backstop the lookup above is the
 * graceful path for: two observations overlapping is a normal race, and a constraint violation
 * taking the caller down over it would be the wrong answer to a row that is already exactly where
 * we want it. The `created_via` stamp is not decoration — `issues/creator.ts` classifies origin by
 * it, and an unstamped row files under the wrong origin and vanishes from the list its reader is
 * watching.
 */
async function file(
  projectId: string,
  createdById: string,
  row: SentryIssueRow,
  baseline: SentrySightingRecord,
): Promise<'filed' | 'raced'> {
  // cm:guard the BASELINE goes in with the row, and leaving it out is not a cosmetic omission. With no `metadata.sentry`, `recordedCount` answers null on the first re-sighting, and a "grew" test written against null treats any count at all as growth — so an issue filed at 17 events and seen again at 17 posts a note saying it got worse. That is the noise the growth test exists to prevent, on the very first observation after filing.
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, description, created_by_id, source, external_id, detector_key, status, created_via, metadata)
    VALUES (${projectId}, ${row.title}, ${row.description}, ${createdById}, ${row.source}, ${row.externalId}, ${row.detectorKey}, ${row.status}, 'system', ${JSON.stringify({ sentry: baseline })}::jsonb)
    ON CONFLICT (project_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (inserted[0] as { id?: string } | undefined)?.id ? 'filed' : 'raced';
}

/**
 * An error that came back after somebody called it done.
 *
 * Returns `null` where this regression asks for no status move, so the caller falls through to what
 * the observation already decided.
 */
// cm:guard `dropped` is NOT reopened, and that is the rule rather than an omission. `closed` is Forge saying the work is done, and evidence that the error is still happening contradicts it — the issue's own contract says Forge cannot hold "fixed" against evidence. `dropped` is a PERSON saying they decided not to fix this, which no amount of recurrence contradicts; a monitoring signal that overrules a person's decision is the one thing this repo's ownership line forbids. The decline is reported by name rather than passed over in silence, because an operator who dropped an issue that keeps firing needs to know it keeps firing.
async function reopenOnRegression(
  existing: ExistingIssue,
  shortId: string,
  ctx: SentryIntakeContext,
): Promise<SentryIntakeOutcome | null> {
  if (existing.status === 'dropped') {
    return {
      kind: 'refused',
      reason: `Sentry reports ${shortId} has regressed, and the Forge issue holding it stands at \`dropped\` — a person decided not to fix this, so it is left where it is rather than reopened. Its counts were still refreshed.`,
    };
  }
  if (existing.status !== 'closed') return null;

  // cm:guard the actor is a `user` carrying an EXPLICIT `agency: null`, and the three states are not interchangeable (`issues/actor-agency.ts`). This write is attributed to the project's creator, because that is whose credential the binding hangs off, but nobody is at the keyboard — an absent `agency` would read `human` and put a webhook's write behind the gates meant for a person's, while `null` is "unestablished" and fails closed to `agent`, which is what a delivery from outside is.
  await transitionIssueStatus(
    {
      id: existing.id,
      projectId: existing.projectId,
      status: 'closed',
      reopenCount: existing.reopenCount,
    },
    'reopen',
    { type: 'user', id: ctx.createdById, agency: null },
    {
      transitionReason: `Sentry reports ${shortId} has regressed: this error is happening again after this issue was closed. Reopened rather than filed a second time — an error coming back is the same work, and the detector key holds at most one live issue for it.`,
    },
  );
  logger.info(
    { projectId: ctx.projectId, issueId: existing.id, shortId },
    'sentry intake: regression reopened a closed issue',
  );
  return { kind: 'reopened' };
}

/**
 * ONE Sentry issue, decided. The whole of what a door has to do with an error.
 *
 * Both callers — `intake.ts`'s scheduled pull and `webhook.ts`'s delivery handler — reach this and
 * nothing else, so neither can answer differently about whether an error is work.
 */
export async function intakeSentryIssue(
  issue: SentryIssueDetail,
  ctx: SentryIntakeContext,
): Promise<SentryIntakeOutcome> {
  // cm:guard the lookup comes FIRST and an already-filed issue is never re-judged: admission decides whether an error becomes work and has nothing to say about an error that already IS work, so judging first lets a threshold raised today silently stop the count updates on the very issues that threshold had already admitted.
  const shortId = issue.shortId?.trim() ?? '';
  const existing = shortId === '' ? null : await findFiled(ctx.projectId, shortId);
  if (existing) {
    const what = await observe(existing, issue, shortId, ctx.createdById);
    // cm:guard the observation is durable BEFORE the transition is attempted, deliberately. The counts and the growth note are what we learned; the reopen is what we do about it. Ordered the other way, a transition that throws would throw away the sighting too, and the next delivery would compare against a stale baseline and call an increase no growth.
    if (issue.substatus === SENTRY_REGRESSED_SUBSTATUS) {
      const regressed = await reopenOnRegression(existing, shortId, ctx);
      if (regressed) return regressed;
    }
    return what === 'commented' ? { kind: 'commented' } : { kind: 'refreshed' };
  }

  const verdict = judgeSentryIssue(issue, ctx.thresholds);
  if (!verdict.admit) return { kind: 'refused', reason: verdict.reason };

  const outcome = await file(
    ctx.projectId,
    ctx.createdById,
    buildSentryIssueRow(issue, verdict.externalId, verdict.detectorKey, ctx.target),
    sighting(issue, verdict.externalId, null),
  );
  if (outcome === 'filed') return { kind: 'filed' };

  // cm:guard a lost race is not a delivery with nothing to do. Another writer holds the key, so the row exists — reload it and OBSERVE it, or this sighting's counts are thrown away and the person watching that issue is told nothing about the increase that arrived with it.
  const winner = await findFiled(ctx.projectId, verdict.externalId);
  if (!winner) {
    return {
      kind: 'refused',
      reason: `the insert for ${verdict.externalId} was refused by the unique index and the row it collided with could not be read back`,
    };
  }
  const what = await observe(winner, issue, verdict.externalId, ctx.createdById);
  return what === 'commented' ? { kind: 'commented' } : { kind: 'refreshed' };
}
