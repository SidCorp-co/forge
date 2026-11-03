// A release's residue (ISS-928): the roster issues a release that shipped could not close. adminhub-api
// 0.9.0 (run 46a3abe4, 2026-11-03) was approved, its promotion merged and production deployed and
// recorded, and 12 of 13 issues closed; ISS-160 was refused for an open question, the run ended
// `failed`, and only the repair door closed it. A shipped release is not unshipped by one refused
// close: it ships, and what it could not close waits at the gate named on the run
// (`metadata.rosterUnclosed`) and held under the refusal that kept it (`unclosed-hold.ts`). Once that
// lifts, the agent's release-record against the same version closes it into that release, through the
// one closer a shipped-in record uses (`shipped-in.ts:shipInto`), and no second run is opened.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { accountActor } from '../issues/index.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { writeReleaseHolds } from './hold.js';
import type { RECORDED_VERIFICATION, RecordedIssue } from './recorded.js';
import { reasonOf, refuseRelease } from './refuse.js';
import { readShippedInRow, type ShippingRelease, shipInto } from './shipped-in.js';
import { openQuestionIdsOf, unclosedHold } from './unclosed-hold.js';

const idsIn = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];

/** The issues a run's metadata names as its residue: those it could not close, less those closed since. */
export function residueOf(metadata: unknown): string[] {
  const meta = (metadata ?? {}) as { rosterUnclosed?: unknown; rosterClosed?: unknown };
  const closed = new Set(idsIn(meta.rosterClosed));
  return idsIn(meta.rosterUnclosed).filter((id) => !closed.has(id));
}

/** Name `unclosed` as the run's residue, in the caller's unit where it holds one. */
export async function markResidue(
  runId: string,
  unclosed: readonly string[],
  executor?: Tx,
): Promise<void> {
  if (unclosed.length === 0) return;
  await writeRunMetadata(
    runId,
    { merge: { rosterUnclosed: [...unclosed] }, touch: false },
    executor,
  );
}

/**
 * Each residue issue back at the gate and held out of every unattended cut, the hold naming the
 * refusal and who clears it. Written once its claim is released: the hold is guarded on the row
 * waiting unclaimed.
 */
export async function holdResidue(
  runId: string,
  version: string | null,
  failed: ReadonlyArray<{ id: string; reason: string }>,
  { shipped = true }: { shipped?: boolean } = {},
): Promise<void> {
  if (failed.length === 0) return;
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run) return;
  const reasons = new Map(failed.map((f) => [f.id, f.reason]));
  const asked = await openQuestionIdsOf(failed.map((f) => f.id));
  await writeReleaseHolds({
    projectId: run.projectId,
    issueIds: failed.map((f) => f.id),
    holdFor: (id) =>
      unclosedHold({
        version,
        refusal: reasons.get(id) ?? '',
        openQuestionIds: asked.get(id) ?? [],
        shipped,
      }),
    now: new Date(),
  });
}

/** A shipped release that still carries a residue, as a release-record against it closes into it. */
export interface ResidueRelease extends ShippingRelease {
  residue: string[];
}

/** The shipped release of this project wearing `version` whose residue is not empty, or null. */
export async function residueRelease(
  projectId: string,
  version: string,
): Promise<ResidueRelease | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      cutAt: pipelineRuns.createdAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.releaseVersion, version),
        isNotNull(pipelineRuns.releaseReleasedAt),
        inArray(sql`${pipelineRuns.metadata}->>'source'`, ['release-batch', 'release-record']),
      ),
    )
    .limit(1);
  if (!run) return null;
  const residue = residueOf(run.metadata);
  if (residue.length === 0) return null;
  const meta = (run.metadata ?? {}) as { commit?: unknown; finish?: { commit?: unknown } };
  const named = meta.finish?.commit ?? meta.commit;
  return {
    runId: run.id,
    version,
    cutAt: run.cutAt,
    commit: typeof named === 'string' ? named : null,
    residue,
  };
}

/**
 * The agent's release-record of residue issues against the release that shipped them: each closed
 * into that release, or named with what refused it and held again. Refused by name where it names
 * an issue that release does not hold as its residue, before anything is written.
 */
export async function closeResidue(
  args: {
    projectId: string;
    userId: string;
    issueIds: string[];
    account: string;
    commit?: string | undefined;
  },
  release: ResidueRelease,
) {
  const held = new Set(release.residue.map((id) => id.toLowerCase()));
  const stray = args.issueIds.filter((id) => !held.has(id.toLowerCase()));
  if (stray.length > 0) {
    throw refuseRelease(
      'RELEASE_RESIDUE_NOT_HELD',
      `Release ${release.version} shipped, and the issues it could not close are ${release.residue.join(', ')}; this record names ${stray.join(', ')}, which it does not hold. A record against a release that shipped closes only its residue: name those, or cut a new release for the rest.`,
      '/issueIds',
    );
  }
  const actor = await accountActor(args.userId);
  const commit = args.commit ?? null;
  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const issues: RecordedIssue[] = [];
  for (const issueId of args.issueIds) {
    const row = await readShippedInRow(args.projectId, issueId);
    if (!row) continue;
    issues.push({
      id: row.id,
      mergedAt: row.landedAt ? row.landedAt.toISOString() : null,
      mergedCommitSha: null,
    });
    try {
      await shipInto({
        projectId: args.projectId,
        row,
        release,
        actor,
        authorId: args.userId,
        notice:
          `Shipped in ${release.version}, recorded by its agent: ${args.account} ` +
          `That release shipped without closing this issue, which waited as its residue; what held it ` +
          `has lifted, so it is closed into ${release.version}.`,
      });
      closed.push(row.id);
    } catch (err) {
      failed.push({ id: row.id, reason: reasonOf(err) });
    }
  }
  await holdResidue(release.runId, release.version, failed);
  return {
    runId: release.runId,
    version: release.version,
    commit,
    identity: null,
    readings: [`recorded by its agent as ${release.version}, closing its residue`],
    // the agent's record is the release (owner, 2026-11-01); typed off recorded.ts, imported as a type only
    verification: 'recorded' as typeof RECORDED_VERIFICATION,
    closed,
    failed,
    issues,
  };
}
