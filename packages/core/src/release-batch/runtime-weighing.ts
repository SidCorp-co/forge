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
import {
  GitHubClientError,
  type GitHubRepoClient,
  githubRepoClient,
} from '../integrations/github/client.js';
import { latestCriterionVerdicts } from '../issues/criteria-verdicts.js';
import { issueIdentities } from '../issues/verdict-standing.js';
import { recognisableIdentity, sameIdentity } from '../messaging/verdict-identity.js';
import type { ReleaseRuntimesConfig } from '../pipeline/pipeline-config-schema.js';
import { PipelineConfigUnreadable } from '../pipeline/pipeline-config-unreadable.js';
import { readStoredPipelineConfig } from '../pipeline/stored-pipeline-config.js';
import { hostOf } from '../projects/live-source.js';
import { type Carriage, type ChangedPaths, carriageOf, changedPathsOf } from './carriage.js';
import { type ServingReading, servedCommits } from './serving-reading.js';
import { carriageKey, type RuntimeReading, rotated, type Weighing } from './weighing.js';
import { WeighingUnreadable } from './weighing-unreadable.js';

/** Uncached reads (one or two compares each) one weighing may make of each kind — landings and
 *  carriages, so neither can starve the other; a cached answer costs none. */
export const WEIGHING_READ_LIMIT = 60;

export interface WeighingDeps {
  client?: (projectId: string) => Promise<GitHubRepoClient>;
  now?: () => Date;
}

async function declaredRuntimes(projectId: string): Promise<ReleaseRuntimesConfig> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .catch((err: unknown) => {
      throw new WeighingUnreadable(
        'declaration',
        `this project's pipelineConfig.releaseRuntimes could not be read: ${why(err)}`,
      );
    });
  const stored = (row?.agentConfig as { pipelineConfig?: unknown } | null)?.pipelineConfig;
  try {
    return readStoredPipelineConfig(projectId, stored).releaseRuntimes ?? [];
  } catch (err) {
    // The patch door refuses a malformed document; one stored past it is a defect to stop on.
    if (err instanceof PipelineConfigUnreadable)
      throw new WeighingUnreadable('declaration', err.message);
    throw err;
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runnerDevices(projectId: string) {
  return db
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
}

/** The build each online, enabled runner device of this project reports. */
async function readProjectRunners(projectId: string, now: () => Date): Promise<ServingReading> {
  const rows = await runnerDevices(projectId).catch((err: unknown) => {
    throw new WeighingUnreadable(
      'runners',
      `this project's runner devices could not be read: ${why(err)}`,
    );
  });
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

async function verdictsOf(projectId: string, issueIds?: readonly string[]) {
  try {
    const rows = await rowsOf(projectId, issueIds);
    return { rows, judged: await judgedCommits(rows) };
  } catch (err) {
    throw new WeighingUnreadable(
      'verdicts',
      `the waiting issues and the commits their verdicts name could not be read: ${why(err)}`,
    );
  }
}

type Reader = { client: GitHubRepoClient } | { why: string };

async function readerFor(projectId: string, deps: WeighingDeps): Promise<Reader> {
  try {
    return { client: await (deps.client ?? githubRepoClient)(projectId) };
  } catch (err) {
    if (!(err instanceof GitHubClientError)) {
      throw new WeighingUnreadable(
        'repository',
        `this project's repository binding could not be read: ${why(err)}`,
      );
    }
    if (err.reason !== 'no_binding') return { why: err.message };
  }
  const repoUrl = await repoUrlOf(projectId).catch((err: unknown) => {
    throw new WeighingUnreadable(
      'repository',
      `this project's repository URL could not be read: ${why(err)}`,
    );
  });
  return { why: noBinding(repoUrl) };
}

async function repoUrlOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.repoUrl?.trim() || null;
}

function onGitHub(host: string): boolean {
  return host === 'github.com' || host.startsWith('github.');
}

/** What a project with no GitHub binding can do, by the host its repository is on. */
export function noBinding(repoUrl: string | null): string {
  const reads = 'Forge reads whether one commit carries another only through a GitHub binding';
  if (!repoUrl) {
    return `this project has no active GitHub binding and names no repository URL, and ${reads} — where its repository is on GitHub, bind it on its Integrations page; anywhere else, a verdict earns here only at a commit this project serves exactly`;
  }
  const host = hostOf(repoUrl);
  if (onGitHub(host)) {
    return 'this project has no active GitHub binding — bind its repository on its Integrations page';
  }
  return `this project's repository is on ${host}, and ${reads}, which a repository there cannot have — so on this project a verdict earns only at a commit it serves exactly`;
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
    } else if ('why' in reader) {
      out.set(row.id, { kind: 'unread', why: reader.why });
    } else {
      out.set(row.id, await changedPathsOf(reader.client, landing, spend));
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
    else out.set(key, await carriageOf(reader.client, j, s, spend));
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
  const { rows, judged } = await verdictsOf(projectId, issueIds);
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
