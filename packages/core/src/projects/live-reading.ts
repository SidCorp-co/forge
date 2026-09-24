import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  GitHubClientError,
  type GitHubRepoClient,
  githubRepoClient,
} from '../integrations/github/client.js';
import { readLiveDivergence } from '../integrations/github/live-divergence.js';
import { heldIssuePrefixes } from '../issues/issue-prefix-read.js';
import { logger } from '../logger.js';
import { issueRefPattern, type LiveReach, type LiveReading, liveReachOf } from './live-reach.js';
import { readableLiveBranch } from './release-model.js';

/** How long one reading answers for a project before the next read takes another. */
export const LIVE_READING_HOLD_MS = 5 * 60_000;
/** How long a read with nothing held waits for the first reading before answering `pending`. */
export const LIVE_READING_FIRST_WAIT_MS = 3_000;

export interface LiveReadingDeps {
  clientFor: (projectId: string) => Promise<GitHubRepoClient>;
  now: () => Date;
}

const defaultDeps: LiveReadingDeps = { clientFor: githubRepoClient, now: () => new Date() };

export interface ProjectReleaseRow {
  id: string;
  releaseModel: string | null;
  releaseStrategy: string | null;
  baseBranch: string | null;
  liveBranch: string | null;
}

interface Held {
  key: string;
  reading: LiveReading;
  expiresAt: number;
}

const held = new Map<string, Held>();
const inFlight = new Map<string, { key: string; reading: Promise<LiveReading> }>();

function keyOf(row: ProjectReleaseRow): string {
  return [row.baseBranch, row.liveBranch ?? '', row.releaseStrategy ?? ''].join('\0');
}

/** Drop what is held for a project, so the next read compares the branches again. */
export function forgetLiveReading(projectId: string): void {
  held.delete(projectId);
  inFlight.delete(projectId);
}

/** Every held reading, dropped. For tests; nothing in the app calls it. */
export function forgetAllLiveReadings(): void {
  held.clear();
  inFlight.clear();
}

/** Take one reading now. Never throws: a failure is a `refused` reading carrying its reason. */
export async function takeLiveReading(
  row: ProjectReleaseRow & { liveBranch: string },
  deps: LiveReadingDeps = defaultDeps,
): Promise<LiveReading> {
  const startedAt = deps.now();
  const refused = (reason: string): LiveReading => ({
    baseBranch: row.baseBranch,
    liveBranch: row.liveBranch,
    kind: 'refused',
    reason,
    startedAt,
  });
  const baseBranch = row.baseBranch;
  if (!baseBranch) {
    return refused(
      `this project names no base branch, so there is nothing to compare ${row.liveBranch} against — set one in its settings`,
    );
  }
  if (row.releaseStrategy === 'cherry-pick') {
    return refused(
      `this project promotes by cherry-pick, which gives every commit a new sha on ${row.liveBranch}, so whether ${row.baseBranch}'s commits reached it cannot be read from the branches`,
    );
  }
  try {
    const client = await deps.clientFor(row.id);
    const d = await readLiveDivergence(client, { baseRef: baseBranch, liveRef: row.liveBranch });
    if (!d.ok) return refused(d.reason);
    const { baseSha, liveSha, aheadBy, commits, complete } = d;
    const liveBranch = row.liveBranch;
    return {
      baseBranch,
      liveBranch,
      kind: 'measured',
      baseSha,
      liveSha,
      aheadBy,
      commits,
      complete,
      startedAt,
    };
  } catch (err) {
    if (!(err instanceof GitHubClientError)) {
      logger.warn({ err, projectId: row.id }, 'live reading: comparing the branches failed');
    }
    return refused(err instanceof Error ? err.message : String(err));
  }
}

function start(
  row: ProjectReleaseRow & { liveBranch: string },
  deps: LiveReadingDeps,
): Promise<LiveReading> {
  const key = keyOf(row);
  const running = inFlight.get(row.id);
  if (running && running.key === key) return running.reading;
  const reading = takeLiveReading(row, deps).then((r) => {
    if (inFlight.get(row.id)?.reading === reading) {
      inFlight.delete(row.id);
      held.set(row.id, { key, reading: r, expiresAt: deps.now().getTime() + LIVE_READING_HOLD_MS });
    }
    return r;
  });
  inFlight.set(row.id, { key, reading });
  return reading;
}

function waitAtMost(reading: Promise<LiveReading>, fallback: LiveReading): Promise<LiveReading> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), LIVE_READING_FIRST_WAIT_MS);
    timer.unref?.();
    void reading.then((r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/**
 * The reading for a project from its release row, or `null` where the project is not `promote`.
 * A held reading is answered as it is; an expired one is answered only if the new one does not
 * arrive within the wait, still carrying the time it was taken.
 */
export async function liveReadingForRow(
  row: ProjectReleaseRow,
  deps: LiveReadingDeps = defaultDeps,
): Promise<LiveReading | null> {
  const liveBranch = readableLiveBranch(row);
  if (!liveBranch) {
    forgetLiveReading(row.id);
    return null;
  }
  const promote = { ...row, liveBranch };
  const key = keyOf(promote);
  const h = held.get(row.id);
  const current = h && h.key === key ? h : null;
  if (current && current.expiresAt > deps.now().getTime()) return current.reading;
  const fallback: LiveReading = current?.reading ?? {
    baseBranch: row.baseBranch,
    liveBranch,
    kind: 'pending',
    reason: `the first comparison of ${row.baseBranch ?? 'the base branch'} against ${liveBranch} is still being taken; read again in a moment`,
  };
  return waitAtMost(start(promote, deps), fallback);
}

const releaseColumns = {
  id: projects.id,
  releaseModel: projects.releaseModel,
  releaseStrategy: projects.releaseStrategy,
  baseBranch: projects.baseBranch,
  liveBranch: projects.liveBranch,
};

export async function projectReleaseRows(projectIds: string[]): Promise<ProjectReleaseRow[]> {
  if (projectIds.length === 0) return [];
  return db.select(releaseColumns).from(projects).where(inArray(projects.id, projectIds));
}

/** One merged issue's place against its project's live branch; `null` where there is none to give. */
export async function liveReachForIssue(
  issue: {
    projectId: string;
    issSeq: number;
    mergedAt: Date | string | null;
    mergedCommitSha: string | null;
  },
  deps: LiveReadingDeps = defaultDeps,
): Promise<LiveReach | null> {
  if (issue.mergedAt == null) return null;
  const [row] = await db
    .select(releaseColumns)
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  if (!row) return null;
  const reading = await liveReadingForRow(row, deps);
  if (!reading) return null;
  const prefixes = await heldIssuePrefixes(issue.projectId);
  return liveReachOf(issue, reading, issueRefPattern(prefixes));
}
