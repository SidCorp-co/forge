/**
 * A shipped release tags the commit it shipped `v<version>` on the project's source host (REQ-63
 * BC-13..15), so a project deployed outside Forge reads its own release version off the tag at build
 * time. Forge holds the credential: the tag goes through the project's source host binding
 * (`source-host/resolve.ts:resolveSourceHost`), never a token a caller sends.
 *
 * The ship's stamp (`pipeline/run-records.ts:stampReleaseShipped`) tells the outbox, and this module's
 * consumer asks the host, so the ship never waits on it or fails for it. The answer is written on the
 * run (`metadata.tag`) whatever it is: a tag that could not be put is said on the release by name,
 * never left for a reader to infer. A tag already on the commit is answered as it stands; one of that
 * name on another commit is refused `RELEASE_TAG_CONFLICT`, naming that commit, and never moved.
 */

import { type ReleaseTag, type ReleaseTagCode, releaseTagName } from '@forge/contracts/releases';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import {
  type HostTagResult,
  resolveSourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { mergeStepsOf } from './change-request-roster.js';
import { readFinishRecord } from './finish-record.js';

const WHOLE = /^[0-9a-f]{40}$/i;

const whole = (v: unknown): string | null =>
  typeof v === 'string' && WHOLE.test(v) ? v.toLowerCase() : null;

/** The tag a run carries, or null where it carries none it can read. */
export function releaseTagOf(metadata: unknown): ReleaseTag | null {
  const raw = (metadata as { tag?: unknown } | null)?.tag;
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Partial<ReleaseTag>;
  if (
    (t.state !== 'tagged' && t.state !== 'refused' && t.state !== 'untagged') ||
    typeof t.name !== 'string' ||
    typeof t.at !== 'string'
  ) {
    return null;
  }
  return {
    state: t.state,
    name: t.name,
    commit: whole(t.commit),
    created: t.created === true,
    on: whole(t.on),
    code: t.code ?? null,
    reason: typeof t.reason === 'string' ? t.reason : null,
    at: t.at,
  };
}

/**
 * The commit a shipped release shipped: what a verified deploy served, else the commit its finish
 * named, else the commit its record verified, else the last of its declared merges. Null where the
 * run names none whole (a storefront release, proved by what its provider publishes).
 */
async function shippedCommitOf(runId: string, metadata: unknown): Promise<string | null> {
  const meta = (metadata ?? {}) as { servedCommit?: unknown };
  const served = whole(meta.servedCommit);
  if (served) return served;
  const finish = readFinishRecord(metadata);
  const finished = finish?.state === 'finished' ? whole(finish.commit) : null;
  if (finished) return finished;
  const attempts = await db
    .select({ commit: releaseAttempts.commit })
    .from(releaseAttempts)
    .where(and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.verdict, 'ok')))
    .orderBy(desc(releaseAttempts.settledAt), desc(releaseAttempts.startedAt));
  const verified = attempts.map((a) => whole(a.commit)).find((c) => c !== null);
  if (verified) return verified;
  const last = mergeStepsOf(metadata)?.at(-1);
  if (!last) return null;
  const [merged] = await db
    .select({ sha: repoPullRequests.mergeCommitSha })
    .from(repoPullRequests)
    .where(inArray(repoPullRequests.id, [last.pullRequestId]))
    .limit(1);
  return whole(merged?.sha);
}

function recordOf(
  name: string,
  commit: string | null,
  answer: HostTagResult | { code: ReleaseTagCode; reason: string },
): ReleaseTag {
  const at = new Date().toISOString();
  if ('code' in answer) {
    return { state: 'untagged', name, commit, created: false, on: null, ...answer, at };
  }
  if (answer.kind === 'conflict') {
    return {
      state: 'refused',
      name,
      commit,
      created: false,
      on: answer.sha,
      code: 'RELEASE_TAG_CONFLICT',
      reason: `${name} already stands on ${answer.sha}, not on ${commit}, the commit this release shipped; Forge never moves a tag`,
      at,
    };
  }
  return {
    state: 'tagged',
    name,
    commit,
    created: answer.kind === 'created',
    on: null,
    code: null,
    reason: null,
    at,
  };
}

/** Ask the host for the tag; a host that could not be reached or failed is said, never thrown. */
async function askHost(
  projectId: string,
  name: string,
  commit: string,
): Promise<HostTagResult | { code: ReleaseTagCode; reason: string }> {
  let host: Awaited<ReturnType<typeof resolveSourceHost>>;
  try {
    host = await resolveSourceHost(projectId);
  } catch (err) {
    if (err instanceof SourceHostUnavailable) {
      return { code: 'RELEASE_TAG_NO_SOURCE_HOST', reason: err.message };
    }
    throw err;
  }
  try {
    return await host.tagCommit({ name, sha: commit });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      code: 'RELEASE_TAG_HOST_FAILED',
      reason: `${host.fullName} on ${host.host} failed tagging ${name} on ${commit}: ${why}`,
    };
  }
}

/**
 * Tag the release this run shipped and record the answer on the run. Null, and nothing written,
 * where the run has not shipped a version. A tag Forge created stays recorded as created when a
 * later delivery finds it present.
 */
export async function tagShippedRelease(runId: string): Promise<ReleaseTag | null> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      version: pipelineRuns.releaseVersion,
      releasedAt: pipelineRuns.releaseReleasedAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run?.version || !run.releasedAt) return null;
  const name = releaseTagName(run.version);
  const commit = await shippedCommitOf(runId, run.metadata);
  const answer = commit
    ? await askHost(run.projectId, name, commit)
    : {
        code: 'RELEASE_TAG_NO_COMMIT' as const,
        reason: `release ${run.version} recorded no whole commit it shipped, so there is nothing to put ${name} on`,
      };
  const tag = recordOf(name, commit, answer);
  const before = releaseTagOf(run.metadata);
  if (
    tag.state === 'tagged' &&
    before?.created &&
    before.name === name &&
    before.commit === commit
  ) {
    tag.created = true;
  }
  await writeRunMetadata(runId, { merge: { tag }, touch: false });
  if (tag.state !== 'tagged') {
    logger.warn({ runId, tag }, 'release-tag: the shipped release carries no tag of its own');
  }
  return tag;
}

/**
 * The release's tag, put when its ship is told (`release.shipped`, emitted by the stamp in the ship's
 * own unit). A host that failed is recorded on the release and the delivery thrown, so the outbox
 * tries again with backoff and, past its attempts, keeps it dead where a person can replay it.
 */
export function registerReleaseTag(): void {
  consume('release.shipped', {
    name: 'release-tag',
    handle: async (p) => {
      const tag = await tagShippedRelease(p.runId);
      if (tag?.code === 'RELEASE_TAG_HOST_FAILED') {
        throw new Error(`release ${p.version} is not tagged yet: ${tag.reason}`);
      }
    },
  });
}
