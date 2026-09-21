import { logger } from '../../logger.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../store.js';
import { intakeSentryIssue, projectCreatedById, readSentryThresholds } from './intake-issue.js';
import { listSentryIssues, type SentryAdapterContext } from './issues.js';
import { SENTRY_LIST_DEFAULT_LIMIT, SentryListingFailed } from './listing.js';
import { resolveSentryTargets } from './targets.js';
import type { SentryTarget } from './types.js';

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
  const listing = await listSentryIssues(ctx, { targetLabel: target.label });
  let filed = 0;
  let commented = 0;
  let refreshed = 0;
  let reopened = 0;
  let refusedCount = 0;

  const headerAt = report.length;
  report.push(`  target ${target.label}:`);
  if (listing.truncated) {
    report.push(
      `    INCOMPLETE: this target holds more unresolved issues than one tick reads (${listing.pages} page(s) of ${SENTRY_LIST_DEFAULT_LIMIT}). Sentry orders by last seen, so the issues past that point are the SAME ones every tick and no later tick reaches them — this pull does not resume where it stopped. What helps today: give this target a narrower projectSlug, or resolve issues in Sentry so the list shortens.`,
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
      if (err instanceof SentryListingFailed) {
        report.push(
          `  target ${target.label}: listing failed after ${err.partial.pages} page(s), with ${err.partial.refused.length} decision(s) already made`,
        );
        for (const refusal of err.partial.refused) {
          report.push(`    confined out ${refusal.shortId ?? refusal.issueId}: ${refusal.reason}`);
        }
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      failures.push(`  target ${target.label}: ${message}`);
      logger.warn(
        { projectId: args.projectId, target: target.label, err: message },
        'sentry pull: target failed',
      );
    }
  }

  const summary = `${filed} issue(s) filed, ${commented} commented, ${reopened} reopened, across ${targets.length} target(s)`;
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
