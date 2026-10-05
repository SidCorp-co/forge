import { logger } from '../observability/logger.js';
import { consume } from '../outbox/index.js';
import { crossesByCherryPick, promotedBranch, readReleasePath } from '../project-config/index.js';
import type { LiveReading } from './live-reach.js';
import { readProjectDivergence } from './live-source.js';

/** How long one reading answers for a project before the next read takes another. */
const LIVE_READING_HOLD_MS = 5 * 60_000;
/** How long a read with nothing held waits for the first reading before answering `pending`. */
const LIVE_READING_FIRST_WAIT_MS = 3_000;

/** What the project document says a landed change crosses to reach production. */
interface ProjectReleaseRow {
  id: string;
  /** Where work lands (`source.git.defaultBranch`). */
  baseBranch: string | null;
  /** The branch production deploys from where a promotion crosses into it; null where none does. */
  deploysFrom: string | null;
  crossesByCherryPick: boolean;
}

interface Held {
  key: string;
  reading: LiveReading;
  expiresAt: number;
}

const held = new Map<string, Held>();
/** `stale` once a push arrived while it ran: it still answers whoever waits on it, and is never held. */
const inFlight = new Map<string, { key: string; reading: Promise<LiveReading>; stale: boolean }>();

function keyOf(row: ProjectReleaseRow): string {
  return [row.baseBranch, row.deploysFrom, String(row.crossesByCherryPick)].join('\0');
}

/** Drop what is held for a project, so the next read compares the branches again. */
function forgetLiveReading(projectId: string): void {
  held.delete(projectId);
  const running = inFlight.get(projectId);
  if (running) running.stale = true;
}

/** Take one reading now. Never throws: a failure is a `refused` reading carrying its reason. */
async function takeLiveReading(
  row: ProjectReleaseRow & { deploysFrom: string },
): Promise<LiveReading> {
  const startedAt = new Date();
  const refused = (reason: string): LiveReading => ({
    baseBranch: row.baseBranch,
    deploysFrom: row.deploysFrom,
    kind: 'refused',
    reason,
    startedAt,
  });
  const baseBranch = row.baseBranch;
  if (!baseBranch) {
    return refused(
      `this project's document names no default branch, so there is nothing to compare ${row.deploysFrom} against`,
    );
  }
  if (row.crossesByCherryPick) {
    return refused(
      `this project's promotions cross at least one branch by cherry-pick, which gives every commit a new sha further down, so whether ${row.baseBranch}'s commits reached ${row.deploysFrom} cannot be read from the branches`,
    );
  }
  try {
    const d = await readProjectDivergence(row.id, {
      baseRef: baseBranch,
      liveRef: row.deploysFrom,
    });
    if (!d.ok) return refused(d.reason);
    const { baseSha, liveSha, aheadBy, commits, complete } = d;
    return {
      baseBranch,
      deploysFrom: row.deploysFrom,
      kind: 'measured',
      baseSha,
      liveSha,
      aheadBy,
      commits,
      complete,
      startedAt,
    };
  } catch (err) {
    logger.warn({ err, projectId: row.id }, 'live reading: comparing the branches failed');
    return refused(err instanceof Error ? err.message : String(err));
  }
}

/** One comparison in flight per project: a stale or differently keyed one is waited out, not raced. */
function start(row: ProjectReleaseRow & { deploysFrom: string }): Promise<LiveReading> {
  const key = keyOf(row);
  const running = inFlight.get(row.id);
  if (running && running.key === key && !running.stale) return running.reading;
  const before = running ? running.reading.then(() => undefined) : Promise.resolve();
  const reading = before
    .then(() => takeLiveReading(row))
    .then((r) => {
      const entry = inFlight.get(row.id);
      if (entry?.reading === reading) {
        inFlight.delete(row.id);
        if (!entry.stale) {
          held.set(row.id, {
            key,
            reading: r,
            expiresAt: Date.now() + LIVE_READING_HOLD_MS,
          });
        }
      }
      return r;
    });
  inFlight.set(row.id, { key, reading, stale: false });
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
 * The reading for a project from its release row, or `null` where no promotion reaches production.
 * A held reading is answered as it is; an expired one is answered only if the new one does not
 * arrive within the wait, still carrying the time it was taken.
 */
export async function liveReadingForRow(row: ProjectReleaseRow): Promise<LiveReading | null> {
  const deploysFrom = row.deploysFrom;
  if (!deploysFrom) {
    forgetLiveReading(row.id);
    return null;
  }
  const promote = { ...row, deploysFrom };
  const key = keyOf(promote);
  const h = held.get(row.id);
  const current = h && h.key === key ? h : null;
  if (current && current.expiresAt > Date.now()) return current.reading;
  const fallback: LiveReading = current?.reading ?? {
    baseBranch: row.baseBranch,
    deploysFrom,
    kind: 'pending',
    reason: `the first comparison of ${row.baseBranch ?? 'the default branch'} against ${deploysFrom} is still being taken; read again in a moment`,
  };
  return waitAtMost(start(promote), fallback);
}

/** A project's release row, or `null` where its project document cannot say one. */
export async function projectReleaseRow(projectId: string): Promise<ProjectReleaseRow | null> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return null;
  return {
    id: projectId,
    baseBranch: read.path.defaultBranch,
    deploysFrom: promotedBranch(read.path),
    crossesByCherryPick: crossesByCherryPick(read.path),
  };
}

export async function projectReleaseRows(projectIds: string[]): Promise<ProjectReleaseRow[]> {
  const rows = await Promise.all(projectIds.map(projectReleaseRow));
  return rows.filter((r): r is ProjectReleaseRow => r !== null);
}

/** A push makes the held live reading stale, whichever branch it named. */
export function registerLiveReadingInvalidation(): void {
  consume('source.pushed', {
    name: 'live-reading',
    handle: (p) => forgetLiveReading(p.projectId),
  });
}
