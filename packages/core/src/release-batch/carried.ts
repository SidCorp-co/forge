// What outside Forge carries the version a release attempt wore (ADR 0011): the record the next
// attempt's version is decided on (`version-rule.ts:carriersOf`). Two writers, one rule: the abort
// says it while the run ends, and `POST .../carried` says it after, for an attempt that ended
// silent. A declaration only ever ADDS a carrier — a tag somebody reported is never taken back by a
// later "nothing" — so the reading can move from undecided to decided, and from reused to bumped,
// but never the other way.

import {
  RELEASE_VERSION_CARRIER_KINDS,
  type ReleaseVersionCarrier,
} from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { refuseRelease } from './refuse.js';
import { carriersIn } from './version-rule.js';
import { lockProjectVersions, lockRunVersions } from './version-store.js';

export const carrierSchema = z
  .object({
    kind: z.enum(RELEASE_VERSION_CARRIER_KINDS),
    name: z.string().trim().min(1).max(300),
  })
  .strict();

export const carriedSchema = z.array(carrierSchema).max(50);

const same = (a: ReleaseVersionCarrier, b: ReleaseVersionCarrier) =>
  a.kind === b.kind && a.name === b.name;

/** `pushed` and `carried` on one abort must tell one story; two that disagree are refused, not merged. */
export function refuseContradiction(
  pushed: boolean | undefined,
  carried: readonly ReleaseVersionCarrier[] | undefined,
): void {
  if (carried === undefined || pushed === undefined) return;
  if (pushed === false && carried.length > 0) {
    throw refuseRelease(
      'RELEASE_CARRIED_CONTRADICTS',
      `this abort says \`pushed: false\` (nothing of this release left the box) and names ${carried.length} carrier(s) outside Forge (${carried.map((c) => `${c.kind} ${c.name}`).join(', ')}). Send one of them: \`carried\` naming what left, or \`pushed: false\` with \`carried\` left out or empty. Nothing was aborted.`,
      '/carried',
    );
  }
  if (pushed === true && carried.length === 0) {
    throw refuseRelease(
      'RELEASE_CARRIED_CONTRADICTS',
      'this abort says `pushed: true` and `carried: []` (nothing outside Forge carries the version). Name the tag or release commit that was pushed in `carried`, or send `pushed: false`. Nothing was aborted.',
      '/carried',
    );
  }
}

/**
 * Adds `carriers` to what the run already records, keeping every one recorded before. Under the
 * project's version lock, so a cut deciding on this run waits for the write or reads it.
 */
export async function recordCarried(
  runId: string,
  carriers: readonly ReleaseVersionCarrier[],
  by: string,
  executor: Tx,
): Promise<ReleaseVersionCarrier[]> {
  await lockRunVersions(executor, runId);
  const rows = await executor.execute<{ carried: unknown }>(sql`
    SELECT metadata -> 'carried' -> 'carriers' AS carried FROM pipeline_runs WHERE id = ${runId} FOR UPDATE
  `);
  const held = carriersIn(rows[0]?.carried);
  const union = [...held, ...carriers.filter((c) => !held.some((h) => same(h, c)))];
  await writeRunMetadata(
    runId,
    { merge: { carried: { carriers: union, by, at: new Date().toISOString() } }, touch: true },
    executor,
  );
  return union;
}

/**
 * The after-the-fact door: an attempt that ended without saying what left its box is told so here,
 * by somebody who looked. Only an ended, unshipped attempt takes it: a live one says it on its own
 * abort, and a shipped version is the release's for good.
 */
export async function declareCarried(args: {
  projectId: string;
  runId: string;
  carried: readonly ReleaseVersionCarrier[];
  by: string;
}): Promise<{ runId: string; version: string | null; carried: ReleaseVersionCarrier[] }> {
  return db.transaction(async (tx) => {
    await lockProjectVersions(tx, args.projectId);
    const rows = await tx.execute<{
      status: string;
      release_version: string | null;
      release_released_at: Date | null;
    }>(sql`
      SELECT status, release_version, release_released_at FROM pipeline_runs
      WHERE id = ${args.runId} AND project_id = ${args.projectId}
        AND metadata ->> 'source' = 'release-batch'
      FOR UPDATE
    `);
    const run = rows[0];
    if (!run) throw new Error(`release-batch: run ${args.runId} vanished under its own lock`);
    const version = run.release_version ?? '(no version)';
    if (run.release_released_at !== null) {
      throw refuseRelease(
        'RELEASE_CARRIED_SHIPPED',
        `run ${args.runId} shipped ${version}: a shipped version belongs to its release for good, so what else carries it decides nothing. Nothing was recorded.`,
      );
    }
    if (run.status !== 'cancelled' && run.status !== 'failed') {
      throw refuseRelease(
        'RELEASE_CARRIED_RUN_OPEN',
        `run ${args.runId} (${version}) is still ${run.status}: say what carries its version on its own abort, \`POST /api/projects/${args.projectId}/release-batches/${args.runId}/abort\` with \`carried\`. Nothing was recorded.`,
      );
    }
    const carried = await recordCarried(args.runId, args.carried, args.by, tx);
    return { runId: args.runId, version: run.release_version, carried };
  });
}
