/**
 * ISS-1237 — every query that reads `issues` decides about archived rows, checked rather than
 * remembered. A file reading the table must compose `issueArchiveSide(...)`, name
 * `issues.archivedAt`, or compose `memoryOfLiveIssue`; otherwise it is listed below with the
 * reason it may answer an archived issue.
 *
 * A read may answer one when it is keyed by an id, key, seq, commit or run somebody named; when it
 * reads only statuses an archived issue never holds (archiving takes `closed` and `dropped` only);
 * when it answers counts or timings with no issue identity; or when it is a write or a guard. A read
 * that lists issues nobody named composes the predicate instead. A new reader that does neither
 * fails here, and an entry that no longer reads the table undecided fails too.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Reads that may answer archived rows, each with the reason. */
const NOT_DISCOVERY: Record<string, string> = {
  'admin/aggregate-routes.ts': 'lead-time percentiles and open counts, no issue identity',
  'admin/alert-queries.ts': 'starvation counts over queued jobs, no issue identity',
  'admin/metric-series.ts': 'bucketed lead-time sums and counts, no issue identity',
  'admin/pipeline-health-routes.ts': 'reads only `waiting`',
  'agent-sessions/lifecycle-routes.ts': "titles of the session's own issue ids",
  'agent-sessions/routes.ts': 'the one issue a session names',
  'assistant/tools/issue-dedup.ts':
    'reads only `draft` and `open`, which an archived issue never is',
  'assistant/weekly/read-rows.ts':
    'resolves ids already quoted in a reply; existence, not discovery',
  'comments/attachment-routes.ts': 'by comment or attachment id',
  'comments/routes.ts': 'by issue or comment id',
  'comments/service.ts': 'by issue or comment id',
  'devices/admissible.ts': 'reads only backlog-admissible statuses; relations by edge',
  'devices/claim.ts': 'the issue of the claimed job',
  'devices/pool.ts': 'issues of queued jobs on live runs; relations by edge',
  'devices/run-evidence.ts': 'the seqs a run names',
  'devices/run-issue-return.ts': 'the seqs a run names',
  'devices/run-session.ts': 'the seqs a run names',
  'feedback/routes.ts': 'the issue a feedback row links',
  'feedback/service.ts': 'by issue id',
  'integrations/github/contract-answer.ts': 'by issue id',
  'integrations/github/issue-link.ts': 'the seq a pull request names',
  'integrations/github/review-note.ts': 'by issue id, locked for a write',
  'integrations/rocketchat/comment-inbound.ts': 'by issue id, or by mirror and comment rows',
  'integrations/rocketchat/comment-mirror.ts':
    'by comment rows owed a delivery, and the thread root by id',
  'integrations/rocketchat/question-delivery.ts': 'the issue an owed question names',
  'integrations/sentry/intake-issue.ts':
    'by the Sentry external id; a regression on an archived issue is refused by name',
  'issues/apply-transition.ts': 'by issue id',
  'issues/attachment-routes.ts': 'by issue or attachment id',
  'issues/attributes/read.ts': 'the ids attribute values reference',
  'issues/attributes/routes.ts': 'by issue id',
  'issues/create-service.ts': 'the existing row a dedup names',
  'issues/criteria-verdicts.ts': 'the ids passed in',
  'issues/dependency-routes.ts': 'the two ends of the edge being written',
  'issues/dependency-service.ts': 'the two ends of the edge being written, refused when archived',
  'issues/detector-key.ts':
    "the caller's detector key, an identity match; a dropped row keeps its standing no when archived",
  'issues/display-ids.ts': 'the ids passed in',
  'issues/drop-cascade.ts': 'dependents over live edges of the dropped issue, a write path',
  'issues/drop-unblock.ts': 'by issue id',
  'issues/entry-criteria.ts': 'by issue id',
  'issues/extras-routes.ts': 'by id; pipeline timing is an aggregate with no identity',
  'issues/merge-record.ts': 'by issue id',
  'issues/merge-routes.ts': 'by issue id',
  'issues/merged-at.ts': 'by issue id, a guard',
  'issues/pipeline-health.ts': 'the ids passed in',
  'issues/read-service.ts': 'retrieval by id or key, which answers an archived issue by design',
  'issues/release-record-required.ts': 'the ids passed in',
  'issues/steer-routes.ts': 'by issue id',
  'issues/transition.ts': 'dependents over edges of the issues being moved',
  'issues/update-service.ts': 'guards by issue id inside a write',
  'jobs/agent-session-link.ts': 'the issue of the job',
  'jobs/budget-check.ts': 'by issue id',
  'jobs/finalize-failure.ts': 'the issue of the job',
  'jobs/prepare-claimed-job.ts': 'the issue of the job',
  'jobs/queued-gates.ts': 'queued jobs only',
  'jobs/routes.ts': 'by issue id',
  'jobs/turn-verdict-routes.ts': 'the issue of the job',
  'labels/module-rollup.ts': 'per-module counts, no issue identity',
  'me/pulse-flow.ts': 'weekly counts, no issue identity',
  'me/pulse-live.ts':
    'work merged and not yet on live, keyed by base-branch commits; hiding it would hide code not deployed',
  'me/pulse-liveness.ts': 'live jobs and running or paused runs',
  'me/pulse-quality.ts': 'counts, no issue identity',
  'me/pulse-work.ts': 'reads only in-flight and release statuses, and counts',
  'memory/chunk-writer.ts': 'the issue a memory row names',
  'memory/extraction.ts': 'by issue id',
  'messaging/gather.ts': 'the ids and seqs a message cites',
  'metrics/queries.ts': 'throughput and cycle-time aggregates, no issue identity',
  'notifications/notify-mentions.ts': 'by issue id',
  'notifications/notify-transitions.ts': 'by issue id',
  'pipeline/analytics-routes.ts':
    'run timings carrying an issue id and no content; the issue page reads its own through here',
  'pipeline/answer-resume.ts': 'reads only the question status',
  'pipeline/autonomous-rescue-cap.ts': 'by issue id',
  'pipeline/ci-fix-pattern-learn.ts': 'by issue id',
  'pipeline/driver-comparison.ts': 'per-project and per-driver counts, no issue identity',
  'pipeline/idle-issues.ts': 'reads only non-terminal statuses',
  'pipeline/inv7-alarms.ts': 'held or queued jobs and running runs',
  'pipeline/issue-run-invariant.ts': 'reads only work-in-progress statuses',
  'pipeline/pipeline-config-service.ts': 'reads only stage statuses, all non-terminal',
  'pipeline/reconciler.ts': 'reads only entry and in-flight statuses',
  'pipeline/recovery-verifier.ts': 'the issue of the job',
  'pipeline/release-coolify.ts': 'by issue id',
  'pipeline/release-hold.ts': 'the ids passed in',
  'pipeline/release-sweep.ts': 'reads only `awaiting_release`, or the ids passed in',
  'pipeline/retention/statements.ts': 'a NOT EXISTS guard keyed by entity id',
  'pipeline/runs-control.ts': 'the issue of the run',
  'pipeline/runs-rollup.ts': 'the issues of the runs',
  'pipeline/stranded-issues.ts': 'reads only `waiting` and non-terminal merged rows',
  'pipeline/sweeper.ts': 'reaps runs still running on closed or dropped issues, a write path',
  'pipeline/work-evidence.ts': 'by issue id',
  'pm/routes.ts': 'the ids a decision event names',
  'pm/snapshot-service.ts': 'status counts; stalled rows read only active statuses',
  'projects/health-aggregates.ts':
    'counts and timings; blockers read only `on_hold` and `needs_info`',
  'projects/routes.ts': 'by issue id',
  'projects/service.ts': 'by issue id',
  'prompt/issue-snapshot.ts':
    'the one issue a job runs on, by id; an archived issue is terminal and runs no job',
  'questions/read.ts': 'by issue id',
  'questions/write.ts': 'by issue id',
  'release-batch/blockers.ts': 'gate statuses, counted; claims by id',
  'release-batch/queries.ts': 'reads only the gate status, or rows of one release run',
  'release-batch/recorded.ts': 'the ids passed in',
  'release-batch/releasing-recovery.ts': 'rows of one release run',
  'release-batch/service.ts': 'the ids passed in, or rows of one release run',
  'runners/routes.ts': 'issues of dispatched or running jobs',
  'tasks/routes.ts': 'by issue id',
  'uploads/attachment-bytes.ts': 'by attachment id',
  'uploads/attachment-lookup.ts': 'by issue, comment or attachment id',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so a note quoting `.from(issues)` cannot trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const READS_ISSUES =
  /\.(?:from|innerJoin|leftJoin|rightJoin)\(\s*(?:schema\.)?issues\b|\b(?:FROM|JOIN)\s+"?issues"?\b/;
const DECIDES = /issueArchiveSide\(|issues\.archivedAt|memoryOfLiveIssue/;

type Reading = 'reads-and-decides' | 'reads-undecided' | 'no-read';

function classify(source: string): Reading {
  const text = stripComments(source);
  if (!READS_ISSUES.test(text)) return 'no-read';
  return DECIDES.test(text) ? 'reads-and-decides' : 'reads-undecided';
}

function scan(): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const abs of listSourceFiles(SRC_ROOT)) {
    const rel = abs.slice(SRC_ROOT.length).replace(/^\//, '');
    if (rel.startsWith('db/')) continue;
    out.set(rel, classify(readFileSync(abs, 'utf8')));
  }
  return out;
}

describe('every reader of issues decides about archived rows (ISS-1237)', () => {
  const found = scan();

  it('finds no reader that neither composes the predicate nor is listed', () => {
    const undecided = [...found]
      .filter(([, reading]) => reading === 'reads-undecided')
      .map(([rel]) => rel)
      .filter((rel) => !(rel in NOT_DISCOVERY));
    expect(
      undecided,
      'compose issueArchiveSide(includeArchived) from issues/archive.ts in the read, or add the ' +
        'file to NOT_DISCOVERY with the reason it may answer archived issues',
    ).toEqual([]);
  });

  it('holds no listed entry that has stopped being an undecided reader', () => {
    const stale = Object.keys(NOT_DISCOVERY).filter((rel) => found.get(rel) !== 'reads-undecided');
    expect(stale, 'remove these entries: they no longer read issues undecided').toEqual([]);
  });

  it('sees a planted reader, and sees it decide', () => {
    expect(classify('db.select().from(issues).where(eq(issues.id, x))')).toBe('reads-undecided');
    expect(classify('sql`SELECT 1 FROM issues i`')).toBe('reads-undecided');
    expect(classify('db.select().from(issues).where(and(...issueArchiveSide(false)))')).toBe(
      'reads-and-decides',
    );
    expect(classify('// .from(issues) in a comment\nconst x = 1;')).toBe('no-read');
  });
});
