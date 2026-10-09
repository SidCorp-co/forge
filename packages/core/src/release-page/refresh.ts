// When a release's highlights are drafted (REQ-40 BC-2): on every move of its release run (the cut,
// the deploy, the finish), and on every verdict recorded against a commit for an issue it carries,
// since either can change what the page may claim. Each trigger refreshes; the digest decides
// whether a draft is owed. Delivered through the outbox, so a trigger is never lost to a crash.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { isRefusal } from '../lib/refusal.js';
import { consume } from '../outbox/index.js';
import { type DraftOutcome, draftHighlights } from './draft.js';
import { claimDraft, highlightsRow, refreshFailed, settleDraft, storeNone } from './highlights.js';
import { pageFacts, releaseDetailOf } from './read.js';

export type RefreshOutcome =
  | 'not_a_release'
  | 'superseded'
  | 'none'
  | 'unchanged'
  | 'in_flight'
  | DraftOutcome['kind'];

type Drafter = typeof draftHighlights;

async function releaseRunOf(runId: string): Promise<{ projectId: string; version: string } | null> {
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId, version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, runId), isNotNull(pipelineRuns.releaseVersion)))
    .limit(1);
  return run?.version ? { projectId: run.projectId, version: run.version } : null;
}

/** Refreshes one release run's highlights: drafts them where no stored draft answers today's facts. */
export async function refreshReleaseHighlights(
  projectId: string,
  runId: string,
  draft: Drafter = draftHighlights,
): Promise<RefreshOutcome> {
  const run = await releaseRunOf(runId);
  if (!run || run.projectId !== projectId) return 'not_a_release';
  let detail: Awaited<ReturnType<typeof releaseDetailOf>>;
  try {
    detail = await releaseDetailOf(projectId, run.version, null);
  } catch (err) {
    // a version whose roster went on under another one has no page of its own
    if (isRefusal(err, 'RELEASE_PAGE_NOT_FOUND')) return 'superseded';
    throw err;
  }
  if (detail.runId !== runId) return 'superseded';
  const page = await pageFacts(projectId, detail);
  const ref = { projectId, runId, version: run.version };
  const row = await highlightsRow(runId);
  const same = row?.sourceDigest === page.digest;
  if (page.facts.requirements.length === 0) {
    if (!(same && row?.state === 'none')) await storeNone(ref, page.digest);
    return 'none';
  }
  if (same && row?.state !== 'pending' && row?.state !== 'none') return 'unchanged';
  if (!(await claimDraft(ref, page.digest))) return 'in_flight';
  const outcome = await draft(projectId, page.facts);
  await settleDraft(ref, page.digest, outcome);
  return outcome.kind;
}

/** The release runs of a project that carry `issueId`. */
async function releaseRunsCarrying(projectId: string, issueId: string): Promise<string[]> {
  const rows = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        isNotNull(pipelineRuns.releaseVersion),
        sql`${pipelineRuns.metadata} -> 'issueIds' @> ${JSON.stringify([issueId])}::jsonb`,
      ),
    );
  return rows.map((r) => r.id);
}

/** Refreshes every release carrying the issue a verdict was recorded on. */
export async function refreshForVerdict(projectId: string, issueId: string): Promise<void> {
  for (const runId of await releaseRunsCarrying(projectId, issueId)) {
    await refreshReleaseHighlights(projectId, runId);
  }
}

const running = new Set<Promise<void>>();

/** Starts a refresh no request waits on, for a page read that found its highlights owed. */
export function refreshInBackground(run: { projectId: string; runId: string }): void {
  const done: Promise<void> = refreshReleaseHighlights(run.projectId, run.runId)
    .then(() => undefined)
    .catch((err) => refreshFailed(err, run))
    .finally(() => running.delete(done));
  running.add(done);
}

/** Settles every refresh started in the background, for a caller that must not leave one running. */
export async function backgroundRefreshesSettled(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

export function registerReleaseHighlightsRefresh(): void {
  consume('run.transitioned', {
    name: 'release-highlights',
    handle: async (p) => {
      await refreshReleaseHighlights(p.projectId, p.id);
    },
  });
  consume('verdict.recorded', {
    name: 'release-highlights',
    handle: async (p) => {
      await refreshForVerdict(p.projectId, p.issueId);
    },
  });
}
