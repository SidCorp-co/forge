/**
 * ISS-1085 slice 3 — the inbound half of the Forge/Sentry loop: a Sentry error becomes a Forge
 * issue, pulled on a schedule.
 *
 * A PULL rather than a webhook, and the reason is in the issue's own body: if Forge is down a
 * webhook delivery is lost for good, while a scheduled pull catches up on the next tick. Slice 4
 * adds the webhook, which changes this path's latency and never its capability.
 *
 * ── The order, which is load-bearing ──────────────────────────────────────────────────────────
 * An answer is looked up by `external_id` BEFORE the admission gate is consulted. Admission decides
 * whether an error becomes work; it has nothing to say about an error that already IS work. Judging
 * first would mean an operator who raised a threshold silently stopped the count updates on the
 * very issues that threshold had already admitted — a change to intake policy quietly reaching back
 * over rows it was never about.
 *
 * ── The chokepoint ────────────────────────────────────────────────────────────────────────────
 * Sentry event text is untrusted: an error message usually carries whatever a user typed into the
 * app that crashed, so whoever can trigger an error can write text into an agent's prompt. Two
 * things answer that, and neither is invented here:
 *
 *  1. `sentry/issues.ts:text()` already runs every free-text field through `sanitizeUntrusted` on
 *     the way in, which strips invisible, bidi and tag-block smuggling and unwraps HTML comments.
 *  2. The DATA frame is applied at the agent-facing projection, not at this write —
 *     `prompt/user.ts` frames the title and the description for the pipeline prompt, and
 *     `mcp/tools/forge-issues.ts:serialize` frames both for the MCP single-issue projection. A frame
 *     stored in the database would be DESTROYED by either of them, because `markUntrusted` runs
 *     `stripFrameTokens` over its own input before framing it.
 *
 * cm:guard `mcp/tools/forge-issues.ts:serializeListRow` char-strips a title and does NOT frame it,
 * by the priced decision in its own `cm:why` (the token cap the lean projection exists for). That
 * is the one agent-facing projection a Sentry title reaches unframed, it predates this path, and it
 * is recorded with its measurement at
 * `docs/proposals/an-mcp-list-title-is-char-stripped-and-not-framed.md`. Do not read the two
 * framed projections as "framed everywhere".
 *
 * The third defence is structural and is this file's own: NOTHING a Sentry issue carried decides
 * the filed issue's status, priority, category or labels. `buildSentryIssueRow` returns a closed
 * shape whose `status` is the literal `draft`, so there is no field for Sentry text to steer.
 */

import { and, eq, type SQL, sql } from 'drizzle-orm';
import { readThresholds } from '../../admin/thresholds.js';
import { db } from '../../db/client.js';
import { comments, issues, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../store.js';
import { judgeSentryIssue } from './admission.js';
import { listSentryIssues, type SentryAdapterContext } from './issues.js';
// cm:edge contract -> packages/core/src/integrations/sentry/listing.ts — the reach constant and the
// partial-failure carrier are the LISTING's, taken from it directly rather than through `issues.ts`.
import { SENTRY_LIST_DEFAULT_LIMIT, SentryListingFailed } from './listing.js';
import { resolveSentryTargets } from './targets.js';
import type { SentryIssueDetail, SentryTarget } from './types.js';

/** The status a pulled Sentry issue is filed at, and the only one this path ever writes. */
export const SENTRY_FILED_STATUS = 'draft' as const;
/** The `issues.source` value this path writes. */
export const SENTRY_ISSUE_SOURCE = 'sentry' as const;

const TITLE_CAP = 200;

export interface SentryPullOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
}

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
 * one: the columns those would be take their own defaults. `status` is a literal. This is what
 * criterion 31 is asserted against, because "no text decides a field" is provable about a shape and
 * only arguable about a code path.
 */
export interface SentryIssueRow {
  title: string;
  description: string;
  status: typeof SENTRY_FILED_STATUS;
  source: typeof SENTRY_ISSUE_SOURCE;
  externalId: string;
  detectorKey: string;
}

/** Bound a TITLE, which is a column a person scans. Never used for the run's own record. */
function capTitle(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The title and body a Sentry issue becomes.
 *
 * Both fields are already `sanitizeUntrusted`-stripped by `issues.ts:text()`. The title is capped
 * because it is a column a person scans, and the structural fields (counts, timestamps, permalink)
 * are written by this code from typed values rather than copied out of free text.
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
 * The jsonb the re-sighting writes — a MERGE, never a replacement.
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
function sighting(
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

interface ExistingIssue {
  id: string;
  metadata: Record<string, unknown> | null;
}

async function findFiled(projectId: string, externalId: string): Promise<ExistingIssue | null> {
  const [row] = await db
    .select({ id: issues.id, metadata: issues.metadata })
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
    ? { id: row.id, metadata: (row.metadata ?? null) as Record<string, unknown> | null }
    : null;
}

/** The event count the last sighting recorded, or `null` where none was ever recorded. */
export function recordedCount(metadata: Record<string, unknown> | null): number | null {
  const entry = (metadata?.sentry ?? null) as { count?: unknown } | null;
  if (!entry || typeof entry.count !== 'number') return null;
  return entry.count;
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
  // cm:guard ONE transaction, and the row is re-read inside it UNDER A LOCK. These are two writes
  // and criterion 17 says exactly one comment, which neither ordering of two independent statements
  // can promise: whichever goes first, a failure between them is either a note nobody ever gets or
  // a note everybody gets twice, and two ticks overlapping read the same baseline and both comment.
  // The lock is what makes the baseline this observation compares against the one no other observer
  // can still be holding. `existing.metadata` from the pre-gate lookup is deliberately NOT reused
  // here — it was read outside this transaction and may already be stale.
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
 * graceful path for: two ticks overlapping is a normal race, and a constraint violation taking the
 * whole pull down over it would be the wrong answer to a row that is already exactly where we want
 * it. The `created_via` stamp is not decoration — `issues/creator.ts` classifies origin by it, and
 * an unstamped row files under the wrong origin and vanishes from the list its reader is watching.
 */
async function file(
  projectId: string,
  createdById: string,
  row: SentryIssueRow,
  baseline: SentrySightingRecord,
): Promise<'filed' | 'raced'> {
  // cm:guard the BASELINE goes in with the row, and leaving it out is not a cosmetic omission. With
  // no `metadata.sentry`, `recordedCount` answers null on the first re-sighting, and a "grew" test
  // written against null treats any count at all as growth — so an issue filed at 17 events and
  // seen again at 17 posts a note saying it got worse. That is the noise the growth test exists to
  // prevent, on the very first tick after filing.
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, description, created_by_id, source, external_id, detector_key, status, created_via, metadata)
    VALUES (${projectId}, ${row.title}, ${row.description}, ${createdById}, ${row.source}, ${row.externalId}, ${row.detectorKey}, ${row.status}, 'system', ${JSON.stringify({ sentry: baseline })}::jsonb)
    ON CONFLICT (project_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (inserted[0] as { id?: string } | undefined)?.id ? 'filed' : 'raced';
}

async function projectCreatedById(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy ?? null;
}

async function pullOneTarget(
  ctx: SentryAdapterContext,
  target: SentryTarget,
  projectId: string,
  createdById: string,
  thresholds: { minEventCount: number; minUserCount: number },
  report: string[],
): Promise<{ filed: number; commented: number }> {
  // cm:why NO `requestId` is passed, deliberately. `deliveries.ts:recordDelivery` does a bare
  // insert carrying `requestId` against a unique index on `(bindingId, requestId)` with no
  // `onConflict`, so a request-keyed delivery that is retried dies on the index BEFORE the
  // provider is contacted — priced at `docs/proposals/a-request-keyed-outbound-delivery-cannot-be-retried.md`
  // and deliberately not fixed there, because the fix decides what a delivery row means. This pull
  // is not an outbound dispatch: it runs inside core from the sweeper tick, nothing enqueues it and
  // nothing retries it, and the listing's delivery row is a record of one call rather than an
  // idempotency key. Omitting the id is what keeps it out of that defect's way. Do not add one
  // here to "make the delivery traceable" without reading that proposal first.
  const listing = await listSentryIssues(ctx, { targetLabel: target.label });
  let filed = 0;
  let commented = 0;
  let refreshed = 0;
  let refusedCount = 0;

  // cm:guard EVERY decision is pushed into the shared report AS IT IS MADE, never buffered locally
  // and flushed at the end. A local buffer flushed after the loop is lost the moment any issue in
  // the loop throws — and what is lost is precisely the named refusals this whole path exists to
  // surface, leaving the operator a bare target error where there were thirty refusals and four
  // filings. The header line goes in FIRST, before anything can throw, so the report always says
  // which target the lines under it belong to.
  const headerAt = report.length;
  report.push(`  target ${target.label}:`);
  if (listing.truncated) {
    report.push(
      `    INCOMPLETE: this target holds more unresolved issues than one tick reads (${listing.pages} page(s) of ${SENTRY_LIST_DEFAULT_LIMIT}). Sentry orders by last seen, so the issues past that point are the SAME ones every tick and no later tick reaches them — this pull does not resume where it stopped, and that is recorded at docs/proposals/a-bounded-sentry-pull-does-not-resume.md. What helps today: give this target a narrower projectSlug, or resolve issues in Sentry so the list shortens.`,
    );
  }
  for (const refusal of listing.refused) {
    report.push(`    confined out ${refusal.shortId ?? refusal.issueId}: ${refusal.reason}`);
  }

  try {
    for (const issue of listing.issues) {
      // THE LOOKUP COMES FIRST. See this file's header — an issue already filed is observed, never
      // re-judged, so a threshold raised today cannot silence yesterday's issues.
      const shortId = issue.shortId?.trim() ?? '';
      const existing = shortId === '' ? null : await findFiled(projectId, shortId);
      if (existing) {
        const what = await observe(existing, issue, shortId, createdById);
        if (what === 'commented') commented += 1;
        else refreshed += 1;
        continue;
      }

      const verdict = judgeSentryIssue(issue, thresholds);
      if (!verdict.admit) {
        refusedCount += 1;
        report.push(`    refused: ${verdict.reason}`);
        continue;
      }
      const outcome = await file(
        projectId,
        createdById,
        buildSentryIssueRow(issue, verdict.externalId, verdict.detectorKey, listing.target),
        sighting(issue, verdict.externalId, null),
      );
      if (outcome === 'filed') {
        filed += 1;
        continue;
      }
      // cm:guard a lost race is not a tick with nothing to do. Another writer holds the key, so the
      // row exists — reload it and OBSERVE it, or this sighting's counts are thrown away and the
      // person watching that issue is told nothing about the increase that arrived with it.
      const winner = await findFiled(projectId, verdict.externalId);
      if (winner) {
        const what = await observe(winner, issue, verdict.externalId, createdById);
        if (what === 'commented') commented += 1;
        else refreshed += 1;
      } else {
        report.push(
          `    raced ${verdict.externalId}: the insert was refused by the unique index and the row it collided with could not be read back`,
        );
      }
    }
  } finally {
    report[headerAt] =
      `  target ${target.label}: ${listing.issues.length} answered over ${listing.pages} page(s), ${listing.refused.length} confined out, ${filed} filed, ${commented} commented, ${refreshed} refreshed, ${refusedCount} refused`;
  }
  return { filed, commented };
}

/**
 * One scheduled pull for one project.
 *
 * Returns rather than throws, because the caller writes a `schedule_runs` row out of the answer and
 * an operator reading a quiet night has to be able to tell a quiet night from a pull that could not
 * be made. A project with no Sentry binding FAILS by name; it does not report a successful empty
 * pull, which is the same thing as saying nothing happened when in fact nothing could.
 */
export async function runSentryPull(args: { projectId: string }): Promise<SentryPullOutcome> {
  let bindings: BindingWithConnection[];
  try {
    bindings = await listActiveBindingsForProjectProvider(args.projectId, 'sentry');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { status: 'failed', output: '', error: `sentry pull: ${message}` };
  }
  const pair = bindings[0];
  if (!pair) {
    return {
      status: 'failed',
      output: '',
      error:
        'sentry pull: this project has no active Sentry binding, so there is nothing to pull from — connect Sentry and bind it to this project',
    };
  }

  const createdById = await projectCreatedById(args.projectId);
  if (!createdById) {
    return {
      status: 'failed',
      output: '',
      error: 'sentry pull: this project has no creator to file issues as',
    };
  }

  const ctx = buildContextFromBinding<
    SentryAdapterContext['config'],
    SentryAdapterContext['secrets']
  >(pair);
  const targets = resolveSentryTargets(ctx.config);
  if (targets.length === 0) {
    return {
      status: 'failed',
      output: '',
      error: `sentry pull: binding ${pair.binding.id} declares no targets, so no Sentry project can be named`,
    };
  }

  const policy = await readThresholds();
  const thresholds = {
    minEventCount: policy.sentryMinEventCount,
    minUserCount: policy.sentryMinUserCount,
  };
  const report: string[] = [
    `thresholds: ${thresholds.minEventCount} event(s), ${thresholds.minUserCount} user(s)`,
  ];
  let filed = 0;
  let commented = 0;
  const failures: string[] = [];

  for (const target of targets) {
    try {
      const got = await pullOneTarget(ctx, target, args.projectId, createdById, thresholds, report);
      filed += got.filed;
      commented += got.commented;
    } catch (err) {
      // cm:guard a listing that failed part way carries what it had already decided, and those
      // named refusals go into the record BEFORE the failure line. Dropping them because the target
      // ultimately failed would lose findings that are true whatever happened next.
      if (err instanceof SentryListingFailed) {
        report.push(
          `  target ${target.label}: listing failed after ${err.partial.pages} page(s), with ${err.partial.refused.length} decision(s) already made`,
        );
        for (const refusal of err.partial.refused) {
          report.push(`    confined out ${refusal.shortId ?? refusal.issueId}: ${refusal.reason}`);
        }
      }
      // cm:guard one target's failure does not take the others down, and it is NEVER swallowed: it
      // goes into `failures`, which makes the whole run `failed`. A pull that reached two of three
      // targets and reported success would be a state that lies about what it looked at.
      const message = err instanceof Error ? err.message : 'unknown error';
      failures.push(`  target ${target.label}: ${message}`);
      logger.warn(
        { projectId: args.projectId, target: target.label, err: message },
        'sentry pull: target failed',
      );
    }
  }

  const summary = `${filed} issue(s) filed, ${commented} commented, across ${targets.length} target(s)`;
  // cm:guard NOT capped, and the cap that used to be here was the defect rather than the safeguard.
  // This report is the only record these decisions ever get — every named refusal, every confinement
  // and every incompleteness — and trimming it deletes exactly the lines it exists to carry, which
  // is the silence this whole path is built to avoid, arriving through the one door that was meant
  // to prevent it. `schedule_runs.output` is postgres `text` and is unbounded; the report's real
  // bound is structural, since a listing walks at most SENTRY_LIST_MAX_PAGES pages per target.
  // Failures still come first, because the head of a long record is what a person actually reads.
  return failures.length > 0
    ? {
        status: 'failed',
        output: [summary, ...failures, ...report].join('\n'),
        error: `sentry pull: ${failures.length} of ${targets.length} target(s) failed`,
      }
    : {
        status: filed === 0 && commented === 0 ? 'skipped' : 'success',
        output: [summary, ...report].join('\n'),
      };
}
