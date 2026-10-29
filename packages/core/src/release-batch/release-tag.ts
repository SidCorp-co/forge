/**
 * A release tags the commit its version names `v<version>` on the project's source host (REQ-63 r7
 * BC-13..15) before anything is deployed from it, so a project deployed outside Forge reads its own
 * release version off the tag at build time with no redeploy. Forge holds the credential: the tag
 * goes through the project's source host binding (`source-host/resolve.ts:resolveSourceHost`), never
 * a token a caller sends.
 *
 * The commit is owed once per run, at the first point it is known (`oweReleaseTag`): a promotion seen
 * merged, or the commit the cut names. That write tells the outbox (`release.committed`) in its own
 * unit, and this module's consumer asks the host, so no release waits on it or fails for it. The
 * answer is written on the run (`metadata.tag`) whatever it is, and whatever the run became since: a
 * release that ends without shipping keeps its tag, and nothing here deletes one. A tag already on the
 * commit is answered as it stands; one of that name on another commit is refused
 * `RELEASE_TAG_CONFLICT`, naming that commit, and never moved.
 */

import { type ReleaseTag, type ReleaseTagCode, releaseTagName } from '@forge/contracts/releases';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import {
  type HostTagResult,
  resolveSourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { consume, emitEvent } from '../outbox/index.js';
import { writeRunMetadata } from '../pipeline/index.js';
import {
  releaseTagOf,
  type TagOwed,
  type TagOwedFrom,
  tagOwedOf,
  wholeCommit,
} from './release-tag-record.js';

/**
 * Owe this run's tag on `commit`, once: the first call that finds the run versioned and owing none
 * writes `metadata.tagOwed` and tells the outbox in the same unit; every later call changes nothing
 * and answers false, so a tag is never re-aimed at a later commit. `commit` null owes a tag the
 * release cannot have (`RELEASE_TAG_NO_COMMIT`).
 */
export async function oweReleaseTag(
  runId: string,
  commit: string | null,
  from: TagOwedFrom,
  executor: Tx = db,
): Promise<boolean> {
  return executor.transaction(async (tx) => {
    const [run] = await tx
      .select({ projectId: pipelineRuns.projectId, version: pipelineRuns.releaseVersion })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1);
    if (!run?.version) return false;
    const owed: TagOwed = {
      name: releaseTagName(run.version),
      commit: wholeCommit(commit),
      from,
      at: new Date().toISOString(),
    };
    const wrote = await writeRunMetadata(
      runId,
      {
        merge: { tagOwed: owed },
        when: sql`NOT (coalesce(${pipelineRuns.metadata}, '{}'::jsonb) ? 'tagOwed')`,
        touch: false,
      },
      tx,
    );
    if (!wrote) return false;
    await emitEvent(tx, 'release.committed', {
      projectId: run.projectId,
      runId,
      version: run.version,
      commit: owed.commit,
    });
    return true;
  });
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
      reason: `${name} already stands on ${answer.sha}, not on ${commit}, the commit this release names; Forge never moves a tag`,
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
 * Put the tag this run owes and record the answer on the run, whether the run is still going,
 * shipped or ended. Null, and nothing written, where no tag is owed. A tag Forge created stays
 * recorded as created when a later delivery finds it present.
 */
export async function tagRelease(runId: string): Promise<ReleaseTag | null> {
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const owed = tagOwedOf(run?.metadata);
  if (!run || !owed) return null;
  const { name, commit } = owed;
  const answer = commit
    ? await askHost(run.projectId, name, commit)
    : {
        code: 'RELEASE_TAG_NO_COMMIT' as const,
        reason: `this release names no whole commit, so there is nothing to put ${name} on`,
      };
  const tag = recordOf(name, commit, answer);
  const before = releaseTagOf(run.metadata);
  if (tag.state === 'tagged' && before?.created && before.commit === commit) tag.created = true;
  await writeRunMetadata(runId, { merge: { tag }, touch: false });
  if (tag.state !== 'tagged') {
    logger.warn({ runId, tag }, 'release-tag: the release carries no tag of its own');
  }
  return tag;
}

/**
 * The release's tag, put when the commit its version names is told (`release.committed`, emitted
 * where that commit is owed). A host that failed is recorded on the release and the delivery thrown,
 * so the outbox tries again with backoff and, past its attempts, keeps it dead where a person can
 * replay it.
 */
export function registerReleaseTag(): void {
  consume('release.committed', {
    name: 'release-tag',
    handle: async (p) => {
      const tag = await tagRelease(p.runId);
      if (tag?.code === 'RELEASE_TAG_HOST_FAILED') {
        throw new Error(`release ${p.version} is not tagged yet: ${tag.reason}`);
      }
    },
  });
}
