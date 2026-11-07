// ISS-1079 (FB-545): the commit a release shipped, on its finish record (`metadata.finish.commit`),
// where every reader of a shipped release already looks (`shipped-releases.ts:shippedReleaseRuns`,
// `shipped-holding.ts`). A finish whose caller named none completed the release with nothing there,
// so a verdict judged at the commit production served counted for none of the issues it carried
// (sidcorp-mail 0.16.0, 62a4ac7). Two writers fill it, each only while it is empty: the deploy this run
// dispatched, once it is both seen and finished (`recordObservedShippedCommit`), and the agent, through
// a door that refuses a commit not carrying every landing the release carried (`attachShippedCommit`).

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { issueDisplayIds } from '../issues/index.js';
import { readDeployHolds, writeRunMetadata } from '../pipeline/index.js';
import { readFinishRecord, type ShippedCommitSource } from './finish-record.js';
import { landedBuildsOf } from './landed-build.js';
import { refuseRelease } from './refuse.js';
import { oweReleaseTag } from './release-tag.js';
import { commitPlacedOnLanding } from './verdict-commit-placement.js';
import { issueIdsOf } from './versions.js';

const WHOLE = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

/** The door that attaches a shipped commit to a release that finished without one. */
export const shippedCommitDoor = (projectId: string, runId: string) =>
  `POST /api/projects/${projectId}/release-batches/${runId}/shipped-commit`;

/** What was recorded as the release's shipped commit, or, with `commit: null`, why nothing was. */
export interface ShippedCommitOutcome extends ShippedCommitSource {
  runId: string;
  commit: string | null;
}

type Holds = Awaited<ReturnType<typeof readDeployHolds>>;

/** What the deploys this run dispatched reported building: one whole commit, or why none is said. */
export function deployedCommitOf(
  holds: Holds,
): { commit: string; said: string } | { commit: null; why: string } {
  const settled = Object.values(holds).filter((h) => h.status === 'succeeded');
  if (settled.length === 0) {
    return { commit: null, why: 'no deploy this run dispatched settled succeeded' };
  }
  const where = settled
    .map((h) => `\`${h.targetLabel}\` (deployment ${h.deploymentUuid ?? 'unnamed'})`)
    .join(', ');
  const named = settled.flatMap((h) => (h.commit ? [h.commit.trim().toLowerCase()] : []));
  if (named.length === 0) {
    return {
      commit: null,
      why: `no deploy this run dispatched reported the commit it built: ${where} settled naming none`,
    };
  }
  const whole = [...new Set(named.filter((c) => WHOLE.test(c)))];
  const [one] = whole;
  if (whole.length !== 1 || !one || named.some((c) => !one.startsWith(c))) {
    return {
      commit: null,
      why: `no deploy this run dispatched reported one whole commit: ${where} reported ${[...new Set(named)].join(', ')}`,
    };
  }
  return { commit: one, said: `the deploy of ${where} reported building it once it settled` };
}

interface ReleaseRunRow {
  projectId: string;
  metadata: Record<string, unknown>;
  releasedAt: Date | null;
}

async function readRun(runId: string): Promise<ReleaseRunRow | null> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run) return null;
  return { ...run, metadata: (run.metadata ?? {}) as Record<string, unknown> };
}

/** A release batch that shipped: its finish finished and its ship stamped. */
function shippedRelease(run: ReleaseRunRow | null): run is ReleaseRunRow {
  if (run?.metadata.source !== 'release-batch' || run.releasedAt === null) return false;
  return readFinishRecord(run.metadata)?.state === 'finished';
}

/**
 * Write `commit` and where it came from onto a finished finish record that names no commit yet,
 * bumping the record's version as every finish write does. False where it already names one.
 */
async function writeShipped(
  runId: string,
  commit: string | null,
  shipped: ShippedCommitSource,
): Promise<boolean> {
  const finish = sql`${pipelineRuns.metadata} -> 'finish'`;
  const patch = { ...(commit ? { commit } : {}), shipped, updatedAt: new Date().toISOString() };
  return writeRunMetadata(runId, {
    value: sql`jsonb_set(${pipelineRuns.metadata}, '{finish}', ${finish} || ${JSON.stringify(patch)}::jsonb
      || jsonb_build_object('version', coalesce((${finish} ->> 'version')::int, 0) + 1))`,
    when: and(sql`${finish} ->> 'state' = 'finished'`, sql`${finish} ->> 'commit' IS NULL`),
    touch: false,
  });
}

/**
 * A shipped release whose finish named no commit records the one the deploy it dispatched reported,
 * as soon as both are true: called once its finish completes and once its deploy settles, whichever
 * is last. Where no deploy reported one, the record says so and names the door that attaches it.
 * Null where the run is no shipped release batch, or already names its commit.
 */
export async function recordObservedShippedCommit(
  runId: string | null,
): Promise<ShippedCommitOutcome | null> {
  if (!runId) return null;
  const run = await readRun(runId);
  if (!shippedRelease(run) || readFinishRecord(run.metadata)?.commit) return null;
  const deployed = deployedCommitOf(await readDeployHolds(runId));
  if ('said' in deployed) {
    const shipped = { from: 'deploy' as const, said: deployed.said };
    if (!(await writeShipped(runId, deployed.commit, shipped))) return null;
    await oweReleaseTag(runId, deployed.commit, 'finish');
    return { runId, commit: deployed.commit, ...shipped };
  }
  const said = `${deployed.why}, so this release names no commit it shipped and no verdict judged on production reaches the issues it carried; attach the commit production serves with ${shippedCommitDoor(run.projectId, runId)}`;
  const shipped = { from: null, said };
  if (!(await writeShipped(runId, null, shipped))) return null;
  return { runId, commit: null, ...shipped };
}

/** Each issue the release carried whose landing `commit` does not hold, said for its refusal. */
async function landingsNotCarried(
  projectId: string,
  issueIds: readonly string[],
  commit: string,
): Promise<{ lacks: string[]; unread: string[] }> {
  const [builds, keys] = await Promise.all([
    landedBuildsOf(issueIds),
    issueDisplayIds([...issueIds]),
  ]);
  const lacks: string[] = [];
  const unread: string[] = [];
  for (const id of issueIds) {
    const key = keys.get(id) ?? id;
    const build = builds.get(id.toLowerCase());
    if (!build || build.sha === null) {
      unread.push(`${key} names no landing to place it on (${build?.why ?? 'not found'})`);
      continue;
    }
    const placed = await commitPlacedOnLanding(projectId, build.sha, commit);
    if ('unread' in placed) {
      unread.push(
        `whether it holds ${key}'s landing \`${short(build.sha)}\` was not read: ${placed.unread}`,
      );
    } else if (!placed.placed || placed.how === 'carried') {
      const how = placed.placed ? 'is earlier than' : 'does not hold';
      lacks.push(`it ${how} ${key}'s landing \`${short(build.sha)}\``);
    }
  }
  return { lacks, unread };
}

/**
 * The agent attaches the commit a shipped release serves to a release that finished naming none
 * (ISS-1079). Refused by name where the run is no shipped release, where it already names one, and
 * where the commit does not hold the landing of every issue it carried, by the ancestry the release
 * already reads (`verdict-commit-placement.ts:commitPlacedOnLanding`), or that could not be read.
 */
export async function attachShippedCommit(args: {
  projectId: string;
  runId: string;
  commit: string;
  evidence?: string | undefined;
  userId: string;
}): Promise<ShippedCommitOutcome> {
  const { projectId, runId } = args;
  const commit = args.commit.trim().toLowerCase();
  const run = await readRun(runId);
  if (!shippedRelease(run) || run.projectId !== projectId) {
    throw refuseRelease(
      'RELEASE_SHIPPED_COMMIT_NOT_SHIPPED',
      `Release run ${runId} is no release batch of this project that shipped: a shipped commit is attached only to a release whose finish finished and whose ship is stamped. Finish it with POST /api/projects/${projectId}/release-batches/${runId}/finish naming \`commit\`.`,
    );
  }
  const held = readFinishRecord(run.metadata)?.commit;
  if (held) {
    throw refuseRelease(
      'RELEASE_SHIPPED_COMMIT_HELD',
      `Release run ${runId} already records \`${held}\` as the commit it shipped, and a shipped commit is never re-aimed: a verdict judged at another commit counts where that commit holds the issue's landing.`,
      '/commit',
    );
  }
  const issueIds = issueIdsOf(run.metadata);
  const { lacks, unread } = await landingsNotCarried(projectId, issueIds, commit);
  if (lacks.length > 0) {
    throw refuseRelease(
      'RELEASE_SHIPPED_COMMIT_LACKS_LANDING',
      `\`${short(commit)}\` is not a commit this release shipped: ${lacks.join('; ')}. Send the commit production serves, which holds every landing the release carried.`,
      '/commit',
    );
  }
  if (unread.length > 0) {
    throw refuseRelease(
      'RELEASE_SHIPPED_COMMIT_UNREAD',
      `Nothing could say whether \`${short(commit)}\` holds what this release carried: ${unread.join('; ')}. Send it again once the source host or a box with the checkout answers.`,
      '/commit',
    );
  }
  const evidence = args.evidence ? `: ${args.evidence}` : '';
  const shipped = {
    from: 'attached' as const,
    said: `attached by its agent (${args.userId}) as holding every landing it carried${evidence}`,
  };
  if (!(await writeShipped(runId, commit, shipped))) {
    throw refuseRelease(
      'RELEASE_SHIPPED_COMMIT_HELD',
      `Release run ${runId} recorded its shipped commit while this one was being checked; read it with GET /api/projects/${projectId}/release-batches/${runId}/state.`,
      '/commit',
    );
  }
  await oweReleaseTag(runId, commit, 'finish');
  return { runId, commit, ...shipped };
}
