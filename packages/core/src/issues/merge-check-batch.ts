/**
 * One merge check for a batch (ISS-1294): `pnpm merge-check --probes <issue id>=<criteria read>`,
 * once per issue the batch lands, writes each issue's probes and standing under its id
 * (`issues`), so the batch's one report is recorded on each of them. Pure: which part of a report an
 * issue is held to. `merge-check.ts` asks it before the probes are held to the issue's criteria.
 */

import { MERGE_CHECK_ISSUE_NOT_COVERED, type MergeCheckReport } from '@forge/contracts/merge-check';
import type { CheckRefusal } from './merge-check-rules.js';

/**
 * The report as the issue it is recorded on reads it: a report on one issue (or on none) as sent,
 * and a batch's report with that issue's `probes` and `standing` in place of its `issues`, and
 * without the `probes` checks another issue's bindings name; or the
 * refusal naming the issue, the issues the report does cover, and the flag that would cover it.
 */
export function reportForIssue(
  report: MergeCheckReport,
  issue: { id: string; ref: string },
): { report: MergeCheckReport; refusal?: never } | { refusal: CheckRefusal; report?: never } {
  const { issues, ...rest } = report;
  if (!issues) return { report };
  const own = issues.find((x) => x.issue.toLowerCase() === issue.id.toLowerCase());
  if (!own) {
    return {
      refusal: {
        code: MERGE_CHECK_ISSUE_NOT_COVERED,
        path: '/issues',
        detail: `this batch report covers ${issues.map((x) => x.issue).join(', ')}, and not ${issue.ref} (${issue.id}): its probes and standing were never read. Run the merge check with \`--probes ${issue.id}=<its criteria read>\` beside the other issues' and record that report. Nothing was recorded`,
      },
    };
  }
  // the batch ran every issue's probes as checks of its own; those another issue binds are its, so
  // this issue is never held to them (a red probe of B refusing A's record)
  const mine = new Set(own.probes.map((b) => b.check));
  const theirs = new Set(issues.flatMap((x) => (x === own ? [] : x.probes.map((b) => b.check))));
  return {
    report: {
      ...rest,
      checks: rest.checks.filter((c) => c.kind !== 'probes' || mine.has(c.id) || !theirs.has(c.id)),
      probes: own.probes,
      ...(own.standing ? { standing: own.standing } : {}),
    },
  };
}
