/**
 * ISS-1368 — the weighing (`weighing.ts`), read by the caller before any enumerator runs, since
 * `collectReleaseBlockers` reaches no network: the release runtimes this project declares and what
 * each serves now, which paths each waiting issue's landing changed, and what every served commit
 * holds of every commit a verdict was judged at.
 *
 * Every read that fails is kept as the reason it failed, never as an answer: a pair whose carriage
 * was not read is weighed by equality alone, and an issue whose paths were not read owes every
 * runtime. Nothing here can make a criterion earned that equality would not have.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, issues, projects, runners } from '../db/schema.js';
import { latestCriterionVerdicts } from '../issues/criteria-verdicts.js';
import { issueIdentities } from '../issues/verdict-standing.js';
import { recognisableIdentity, sameIdentity } from '../messaging/verdict-identity.js';
import {
  type ReleaseRuntimesConfig,
  releaseRuntimesSchema,
} from '../pipeline/pipeline-config-schema.js';
import { type RepositoryAccessDeps, withRepository } from '../projects/repository-access.js';
import type {
  Carriage,
  ChangedPaths,
  RepositoryAccess,
  RepositoryReader,
} from '../projects/repository-reader.js';
import { carriageOf, changedPathsOf } from './carriage.js';
import { type ServingReading, servedCommits } from './serving-reading.js';
import { carriageKey, type RuntimeReading, rotated, type Weighing } from './weighing.js';

/** Uncached reads (one or two compares each) one weighing may make of each kind — landings and
 *  carriages, so neither can starve the other; a cached answer costs none. */
export const WEIGHING_READ_LIMIT = 60;

export interface WeighingDeps {
  repository?: Partial<RepositoryAccessDeps>;
  now?: () => Date;
}

async function declaredRuntimes(projectId: string): Promise<ReleaseRuntimesConfig> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const pc = (row?.agentConfig as Record<string, unknown> | null)?.pipelineConfig as
    | Record<string, unknown>
    | undefined;
  if (pc?.releaseRuntimes === undefined) return [];
  // The patch door refuses a malformed one; one stored past it is a defect to stop on, not skip.
  const parsed = releaseRuntimesSchema.safeParse(pc.releaseRuntimes);
  if (!parsed.success) {
    throw new Error(
      `this project's stored pipelineConfig.releaseRuntimes is not a valid declaration: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

/** The build each online, enabled runner device of this project reports. */
async function readProjectRunners(projectId: string, now: () => Date): Promise<ServingReading> {
  const rows = await db
    .selectDistinct({ name: devices.name, commit: devices.agentCommit })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(
      and(
        eq(runners.projectId, projectId),
        eq(devices.status, 'online'),
        isNull(devices.disabledAt),
      ),
    )
    .orderBy(devices.name);
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

interface WaitingRow {
  id: string;
  sessionContext: unknown;
  mergedCommitSha: string | null;
}

async function rowsOf(projectId: string, issueIds?: readonly string[]): Promise<WaitingRow[]> {
  const scope = issueIds
    ? inArray(issues.id, [...issueIds])
    : and(eq(issues.status, 'awaiting_release'), isNull(issues.releaseBatchRunId));
  if (issueIds && issueIds.length === 0) return [];
  return db
    .select({
      id: issues.id,
      sessionContext: issues.sessionContext,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), scope))
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`, issues.id);
}

/** Each commit any of these rows' latest verdicts was judged at. */
async function judgedCommits(rows: readonly WaitingRow[]): Promise<string[]> {
  const judged = new Set<string>();
  for (const row of rows) {
    for (const verdict of (await latestCriterionVerdicts(row.id)).values()) {
      if (verdict.at && recognisableIdentity(verdict.at.value)) judged.add(verdict.at.value.trim());
    }
  }
  return [...judged];
}

type Unread = Extract<Carriage, { kind: 'unread' }>;

type Reader = { reader: RepositoryReader } | { unread: Unread };

function readerOf(access: RepositoryAccess): Reader {
  if (access.kind === 'reader') return { reader: access.reader };
  const { cause: why, clears } = access;
  return {
    unread: clears === undefined ? { kind: 'unread', why } : { kind: 'unread', why, clears },
  };
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
  rows: readonly WaitingRow[],
  reader: Reader,
  spend: () => string | null,
): Promise<Map<string, ChangedPaths>> {
  const out = new Map<string, ChangedPaths>();
  for (const row of rotated(rows, passes)) {
    const landing = issueIdentities(row).source;
    if (!landing) {
      out.set(row.id, { kind: 'unread', why: 'this issue records no landing commit' });
    } else if ('unread' in reader) {
      out.set(row.id, reader.unread);
    } else {
      out.set(row.id, await changedPathsOf(reader.reader, landing, spend));
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
    if ('unread' in reader) out.set(key, reader.unread);
    else out.set(key, await carriageOf(reader.reader, j, s, spend));
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
  const declared = await declaredRuntimes(projectId);
  const runtimes: RuntimeReading[] = [];
  let runnersRead: ServingReading | null = null;
  for (const runtime of declared) {
    runnersRead ??= await readProjectRunners(projectId, now);
    runtimes.push({ name: runtime.name, paths: runtime.paths, serving: runnersRead });
  }
  const rows = await rowsOf(projectId, issueIds);
  const judged = await judgedCommits(rows);
  const served = [
    ...new Set([...servedCommits(serving), ...runtimes.flatMap((r) => servedCommits(r.serving))]),
  ];
  const unequal = judged.some((j) => served.some((s) => !sameIdentity(j, s)));
  if (runtimes.length === 0 && !unequal) {
    return { read: true, runtimes, changed: new Map(), carriage: new Map() };
  }
  passes += 1;
  return withRepository(
    projectId,
    async (access) => {
      const reader = readerOf(access);
      const changed = runtimes.length > 0 ? await readChanged(rows, reader, budget()) : new Map();
      const carriage = await readCarriage(judged, served, reader, budget());
      return { read: true, runtimes, changed, carriage };
    },
    deps.repository,
  );
}
