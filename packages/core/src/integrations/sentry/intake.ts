/**
 * ISS-1085 slice 3 — the inbound half of the Forge/Sentry loop, pulled on a schedule.
 *
 * This file is the PULL: targets, pages, the report an operator reads, and the `schedule_runs`
 * outcome. What one Sentry issue gets — the lookup, the admission gate, the filing, the re-sighting
 * and the regression — moved to `intake-issue.ts` when slice 4's webhook became a second caller,
 * so both doors reach one decision rather than two that can drift.
 *
 * ── The chokepoint ────────────────────────────────────────────────────────────────────────────
 * Sentry event text is untrusted: an error message usually carries whatever a user typed into the
 * app that crashed, so whoever can trigger an error can write text into an agent's prompt. Two
 * things answer that, and neither is invented here. `issues.ts:projectIssue` runs every free-text
 * field through `sanitizeUntrusted` on the way in, which strips invisible, bidi and tag-block
 * smuggling and unwraps HTML comments. And the DATA frame is applied at the agent-facing
 * projection, not at the write — `prompt/user.ts` frames the title and the description for the
 * pipeline prompt, and `mcp/tools/forge-issues.ts:serialize` frames both for the MCP single-issue
 * projection. A frame stored in the database would be DESTROYED by either of them, because
 * `markUntrusted` runs `stripFrameTokens` over its own input before framing it.
 */
// cm:guard `mcp/tools/forge-issues.ts:serializeListRow` char-strips a title and does NOT frame it, by the priced decision in its own `cm:why` (the token cap the lean projection exists for). That is the one agent-facing projection a Sentry title reaches unframed, it predates this path, and it is recorded with its measurement at `docs/proposals/an-mcp-list-title-is-char-stripped-and-not-framed.md`. Do not read the two framed projections as "framed everywhere".

import { logger } from '../../logger.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../store.js';
// cm:edge contract -> packages/core/src/integrations/sentry/intake-issue.ts — the per-issue decision is THERE and is shared with the webhook (slice 4); re-implementing any of it here is the drift the split exists to prevent.
import { intakeSentryIssue, projectCreatedById, readSentryThresholds } from './intake-issue.js';
import { listSentryIssues, type SentryAdapterContext } from './issues.js';
// cm:edge contract -> packages/core/src/integrations/sentry/listing.ts — the reach constant and the partial-failure carrier are the LISTING's, taken from it directly rather than through `issues.ts`.
import { SENTRY_LIST_DEFAULT_LIMIT, SentryListingFailed } from './listing.js';
import { resolveSentryTargets } from './targets.js';
import type { SentryTarget } from './types.js';

// cm:why re-exported rather than left to `intake-issue.js` alone: this module is the one the tests, the schedule and the adapter already import from, and splitting a file for a SECOND CALLER must not move every caller's import. The definitions live in one place; this is the door.
export {
  buildSentryIssueRow,
  intakeSentryIssue,
  recordedCount,
  recordedSighting,
  SENTRY_FILED_STATUS,
  SENTRY_ISSUE_SOURCE,
  SENTRY_REGRESSED_SUBSTATUS,
  type SentryIntakeContext,
  type SentryIntakeOutcome,
  type SentryIssueRow,
  type SentrySightingRecord,
  sentryMetadataMerge,
} from './intake-issue.js';

export interface SentryPullOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
}

async function pullOneTarget(
  ctx: SentryAdapterContext,
  target: SentryTarget,
  projectId: string,
  createdById: string,
  thresholds: { minEventCount: number; minUserCount: number },
  report: string[],
): Promise<{ filed: number; commented: number; reopened: number }> {
  // cm:why NO `requestId` is passed, deliberately. `deliveries.ts:recordDelivery` does a bare insert carrying `requestId` against a unique index on `(bindingId, requestId)` with no `onConflict`, so a request-keyed delivery that is retried dies on the index BEFORE the provider is contacted — priced at `docs/proposals/a-request-keyed-outbound-delivery-cannot-be-retried.md` and deliberately not fixed there, because the fix decides what a delivery row means. This pull is not an outbound dispatch: it runs inside core from the sweeper tick, nothing enqueues it and nothing retries it, and the listing's delivery row is a record of one call rather than an idempotency key. Omitting the id is what keeps it out of that defect's way. Do not add one here to "make the delivery traceable" without reading that proposal first.
  const listing = await listSentryIssues(ctx, { targetLabel: target.label });
  let filed = 0;
  let commented = 0;
  let refreshed = 0;
  let reopened = 0;
  let refusedCount = 0;

  // cm:guard EVERY decision is pushed into the shared report AS IT IS MADE, never buffered locally and flushed at the end. A local buffer flushed after the loop is lost the moment any issue in the loop throws — and what is lost is precisely the named refusals this whole path exists to surface, leaving the operator a bare target error where there were thirty refusals and four filings. The header line goes in FIRST, before anything can throw, so the report always says which target the lines under it belong to.
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
      const outcome = await intakeSentryIssue(issue, {
        projectId,
        createdById,
        thresholds,
        target: listing.target,
      });
      if (outcome.kind === 'filed') filed += 1;
      else if (outcome.kind === 'commented') commented += 1;
      else if (outcome.kind === 'refreshed') refreshed += 1;
      else if (outcome.kind === 'reopened') reopened += 1;
      else {
        refusedCount += 1;
        report.push(`    refused: ${outcome.reason}`);
      }
    }
  } finally {
    report[headerAt] =
      `  target ${target.label}: ${listing.issues.length} answered over ${listing.pages} page(s), ${listing.refused.length} confined out, ${filed} filed, ${commented} commented, ${reopened} reopened, ${refreshed} refreshed, ${refusedCount} refused`;
  }
  return { filed, commented, reopened };
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

  const thresholds = await readSentryThresholds();
  const report: string[] = [
    `thresholds: ${thresholds.minEventCount} event(s), ${thresholds.minUserCount} user(s)`,
  ];
  let filed = 0;
  let commented = 0;
  let reopened = 0;
  const failures: string[] = [];

  for (const target of targets) {
    try {
      const got = await pullOneTarget(ctx, target, args.projectId, createdById, thresholds, report);
      filed += got.filed;
      commented += got.commented;
      reopened += got.reopened;
    } catch (err) {
      // cm:guard a listing that failed part way carries what it had already decided, and those named refusals go into the record BEFORE the failure line. Dropping them because the target ultimately failed would lose findings that are true whatever happened next.
      if (err instanceof SentryListingFailed) {
        report.push(
          `  target ${target.label}: listing failed after ${err.partial.pages} page(s), with ${err.partial.refused.length} decision(s) already made`,
        );
        for (const refusal of err.partial.refused) {
          report.push(`    confined out ${refusal.shortId ?? refusal.issueId}: ${refusal.reason}`);
        }
      }
      // cm:guard one target's failure does not take the others down, and it is NEVER swallowed: it goes into `failures`, which makes the whole run `failed`. A pull that reached two of three targets and reported success would be a state that lies about what it looked at.
      const message = err instanceof Error ? err.message : 'unknown error';
      failures.push(`  target ${target.label}: ${message}`);
      logger.warn(
        { projectId: args.projectId, target: target.label, err: message },
        'sentry pull: target failed',
      );
    }
  }

  const summary = `${filed} issue(s) filed, ${commented} commented, ${reopened} reopened, across ${targets.length} target(s)`;
  // cm:guard NOT capped, and the cap that used to be here was the defect rather than the safeguard. This report is the only record these decisions ever get — every named refusal, every confinement and every incompleteness — and trimming it deletes exactly the lines it exists to carry, which is the silence this whole path is built to avoid, arriving through the one door that was meant to prevent it. `schedule_runs.output` is postgres `text` and is unbounded; the report's real bound is structural, since a listing walks at most SENTRY_LIST_MAX_PAGES pages per target. Failures still come first, because the head of a long record is what a person actually reads.
  return failures.length > 0
    ? {
        status: 'failed',
        output: [summary, ...failures, ...report].join('\n'),
        error: `sentry pull: ${failures.length} of ${targets.length} target(s) failed`,
      }
    : {
        status: filed === 0 && commented === 0 && reopened === 0 ? 'skipped' : 'success',
        output: [summary, ...report].join('\n'),
      };
}
