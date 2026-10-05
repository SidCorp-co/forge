/**
 * ISS-1368 — the weighing (`issues/weighing.ts`), read by the caller before any enumerator runs,
 * since `collectReleaseBlockers` reaches no network: the release runtimes the project document
 * declares under `release.runtimes` and what each serves now, which paths each waiting issue's
 * landing changed, and what every served commit holds of every commit a verdict was judged at.
 *
 * Every read that fails is kept as the reason it failed, never as an answer: a pair whose carriage
 * was not read is weighed by equality alone, and an issue whose paths were not read owes every
 * runtime. Nothing here can make a criterion earned that equality would not have.
 */

import { type ServingReading, servedCommits } from '@forge/contracts/releases';
import { projectRunnerBuilds } from '../devices/index.js';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import {
  type Carriage,
  type ChangedPaths,
  carriageKey,
  type RuntimeReading,
  rotated,
  verdictWeighingInputs,
  type Weighing,
} from '../issues/index.js';
import { recognisableIdentity, sameIdentity } from '../messaging/verdict-identity.js';
import { readProjectDocument } from '../project-config/index.js';
import { carriageOf, changedPathsOf } from './carriage.js';

/** Uncached reads (one or two compares each) one weighing may make of each kind — landings and
 *  carriages, so neither can starve the other; a cached answer costs none. */
const WEIGHING_READ_LIMIT = 60;

interface WeighingDeps {
  host?: (projectId: string) => Promise<SourceHost>;
  now?: () => Date;
}

/** The build each online, enabled runner device of this project reports. */
async function readProjectRunners(projectId: string, now: () => Date): Promise<ServingReading> {
  const rows = await projectRunnerBuilds(projectId);
  const readAt = now().toISOString();
  if (rows.length === 0) {
    return {
      kind: 'undeclared',
      missing: 'no runner device of this project is online to report the build it runs',
      route: 'bring one of this project’s runners online',
    };
  }
  const served = rows.flatMap((r) =>
    r.commit && recognisableIdentity(r.commit)
      ? [{ commit: r.commit.trim(), where: `runner device ${r.name}` }]
      : [],
  );
  const silent = rows.filter((r) => !r.commit || !recognisableIdentity(r.commit));
  const unread = silent.map((r) => `runner device ${r.name} reports no build commit`);
  if (served.length === 0) {
    return { kind: 'unreadable', why: unread.join('; '), hosts: rows.map((r) => r.name), readAt };
  }
  return { kind: 'serving', served, unread, readAt };
}

type Reader = { host: SourceHost } | { why: string };

async function readerFor(projectId: string, deps: WeighingDeps): Promise<Reader> {
  try {
    return { host: await (deps.host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId) };
  } catch (err) {
    if (err instanceof SourceHostUnavailable) return { why: err.message };
    throw err;
  }
}

const OVER_BUDGET = `it was not read this pass: one weighing makes at most ${WEIGHING_READ_LIMIT} uncached repository reads of a kind, and each pass starts its reads one place further along`;

/** Charged only where the cache misses; a reason once it is spent. */
function budget(): () => string | null {
  let spent = 0;
  return () => {
    spent += 1;
    return spent <= WEIGHING_READ_LIMIT ? null : OVER_BUDGET;
  };
}

// Each pass starts one place further along, so reads a full budget cut short are first in a later pass.
let passes = 0;

async function readChanged(
  rows: ReadonlyArray<{ id: string; landing: string | null }>,
  reader: Reader,
  spend: () => string | null,
): Promise<Map<string, ChangedPaths>> {
  const out = new Map<string, ChangedPaths>();
  for (const row of rotated(rows, passes)) {
    if (!row.landing) {
      out.set(row.id, { kind: 'unread', why: 'this issue records no landing commit' });
    } else if ('why' in reader) {
      out.set(row.id, { kind: 'unread', why: reader.why });
    } else {
      out.set(row.id, await changedPathsOf(reader.host, row.landing, spend));
    }
  }
  return out;
}

async function readCarriage(
  judged: readonly string[],
  served: readonly string[],
  reader: Reader,
  spend: () => string | null,
): Promise<Map<string, Carriage>> {
  const out = new Map<string, Carriage>();
  const pairs = judged.flatMap((j) => served.filter((s) => !sameIdentity(j, s)).map((s) => [j, s]));
  for (const [j, s] of rotated(pairs, passes) as Array<[string, string]>) {
    const key = carriageKey(j, s);
    if (out.has(key)) continue;
    if ('why' in reader) out.set(key, { kind: 'unread', why: reader.why });
    else out.set(key, await carriageOf(reader.host, j, s, spend));
  }
  return out;
}

/**
 * The weighing for these waiting issues — the project's unclaimed `awaiting_release` rows where
 * none are named — beside `serving`, the deployment's reading the caller already took. A project
 * declaring no runtime, whose verdicts name what it serves, makes no repository read at all.
 */
export async function readWeighingNow(
  projectId: string,
  serving: ServingReading,
  issueIds?: readonly string[],
  deps: WeighingDeps = {},
): Promise<Weighing> {
  const now = deps.now ?? (() => new Date());
  const declared = (await readProjectDocument(projectId))?.document.release?.runtimes ?? [];
  const runtimes: RuntimeReading[] = [];
  let runnersRead: ServingReading | null = null;
  for (const runtime of declared) {
    runnersRead ??= await readProjectRunners(projectId, now);
    runtimes.push({ name: runtime.name, paths: runtime.paths, serving: runnersRead });
  }
  const { rows, judged } = await verdictWeighingInputs(projectId, issueIds);
  const served = [
    ...new Set([...servedCommits(serving), ...runtimes.flatMap((r) => servedCommits(r.serving))]),
  ];
  const unequal = judged.some((j) => served.some((s) => !sameIdentity(j, s)));
  if (runtimes.length === 0 && !unequal) {
    return { read: true, runtimes, changed: new Map(), carriage: new Map() };
  }
  const reader = await readerFor(projectId, deps);
  passes += 1;
  const changed = runtimes.length > 0 ? await readChanged(rows, reader, budget()) : new Map();
  const carriage = await readCarriage(judged, served, reader, budget());
  return { read: true, runtimes, changed, carriage };
}
