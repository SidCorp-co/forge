/** The commits a release range holds, read from a `GitReading`'s fetched history. */

import {
  RANGE_COMMIT_LIMIT,
  type RangeCommit,
  type RangeRead,
} from '../projects/repository-reader.js';
import type { GitReading } from './repository-reading.js';

function splitEntry(entry: string): RangeCommit | null {
  const at = entry.indexOf('\n');
  if (at < 0) return null;
  const message = entry.slice(at + 1);
  const [sha = '', ...parents] = entry.slice(0, at).trim().split(' ');
  if (!sha) return null;
  return { sha, parents, message: message.endsWith('\n') ? message.slice(0, -1) : message };
}

export async function rangeIn(g: GitReading, base: string, headRef: string): Promise<RangeRead> {
  const overlong = await g.overlong(headRef);
  if (overlong) return { why: overlong };
  const tip = await g.head(base);
  if ('why' in tip) return { why: tip.why };
  const to = await g.resolve(headRef);
  if (!to.ok) return { why: to.why };
  const span = `${tip.sha}..${to.commit.sha}`;
  const count = Number((await g.git(['-C', g.history, 'rev-list', '--count', span])).trim());
  if (count > RANGE_COMMIT_LIMIT) {
    return {
      why: `${base}...${headRef} holds more than ${RANGE_COMMIT_LIMIT} commits, more than one release range is read for`,
    };
  }
  const log = await g.git([
    '-C',
    g.history,
    'log',
    '-z',
    '--reverse',
    '--topo-order',
    '--format=%H %P%n%B',
    span,
  ]);
  const commits = log
    .split('\0')
    .map(splitEntry)
    .filter((c): c is RangeCommit => c !== null);
  if (commits.length !== count) {
    return { why: `${g.remote} listed ${commits.length} of the ${count} commits in ${span}` };
  }
  return { commits };
}
