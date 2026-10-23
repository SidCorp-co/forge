// A release's name and summary (REQ-40 BC-14), written once it is drafted and kept through the cut:
// a draft's wait in `release_draft_namings` under its version, and the cut that takes the version
// carries them onto its run as `metadata.naming`, so a release is named in one place at a time. Every
// surface that names the release — its list row, its peek, its page and its exports — reads them
// here; nothing derives one.

import { type ReleaseNaming, ReleaseNamingSchema } from '@forge/contracts/release-notes';
import { and, asc, desc, eq, isNotNull, isNull, ne, notInArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns, releaseDraftNamings } from '../db/schema.js';
import { arrivedAfterOf } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { requireHeld } from '../permissions/index.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { draftedVersion } from './draft-version.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { refuseRelease } from './refuse.js';

export interface StoredNaming extends ReleaseNaming {
  at: string;
  by: string | null;
}

/** The naming a run's metadata carries, or null where none was written: the one reader of it. */
export function readReleaseNaming(metadata: unknown): ReleaseNaming | null {
  const raw = (metadata as { naming?: unknown } | null)?.naming;
  const parsed = ReleaseNamingSchema.safeParse(
    raw && typeof raw === 'object'
      ? { name: (raw as StoredNaming).name, summary: (raw as StoredNaming).summary }
      : raw,
  );
  return parsed.success ? parsed.data : null;
}

function namingStamp(
  naming: ReleaseNaming,
  by: string | null,
  at?: Date,
): { naming: StoredNaming } {
  return { naming: { ...naming, at: (at ?? new Date()).toISOString(), by } };
}

/** The latest run cut as `version`, other than `except`: the attempt a re-cut of it follows. */
export async function runCutAs(
  projectId: string,
  version: string,
  executor: Tx = db,
  except?: string,
) {
  const [run] = await executor
    .select({ id: pipelineRuns.id, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.releaseVersion, version),
        except ? ne(pipelineRuns.id, except) : undefined,
      ),
    )
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(1);
  return run ?? null;
}

async function pendingNaming(projectId: string, version: string, executor: Tx = db) {
  const [row] = await executor
    .select()
    .from(releaseDraftNamings)
    .where(
      and(eq(releaseDraftNamings.projectId, projectId), eq(releaseDraftNamings.version, version)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The name the draft cut as `version` carries: the one written while it was drafted, else the name of
 * the attempt it re-cuts, else null.
 */
export async function draftNaming(
  projectId: string,
  version: string,
): Promise<ReleaseNaming | null> {
  const pending = await pendingNaming(projectId, version);
  if (pending) return { name: pending.name, summary: pending.summary };
  const run = await runCutAs(projectId, version);
  return run ? readReleaseNaming(run.metadata) : null;
}

/**
 * Names the release drafted or cut as `version`, replacing what it was named before: the draft's
 * name waits for its cut, a cut release's is written onto its run. A version that is neither is
 * refused by name, saying which version is drafted.
 */
export async function nameRelease(
  projectId: string,
  version: string,
  naming: ReleaseNaming,
  /** Who named it; null for the assistant's draft (`release-page/naming-refresh.ts`). */
  by: string | null,
): Promise<{ version: string; state: 'draft' | 'cut'; runId: string | null } & ReleaseNaming> {
  const drafted = await draftedVersion(projectId);
  if (version === drafted) {
    await db
      .insert(releaseDraftNamings)
      .values({ projectId, version, ...naming, namedBy: by })
      .onConflictDoUpdate({
        target: [releaseDraftNamings.projectId, releaseDraftNamings.version],
        set: { ...naming, namedBy: by, namedAt: new Date() },
      });
    return { version, state: 'draft', runId: null, ...naming };
  }
  const run = await runCutAs(projectId, version);
  if (!run) {
    const draft = drafted
      ? `the release drafted is ${drafted}`
      : 'nothing waits at the release gate, so no release is drafted';
    throw refuseRelease(
      'RELEASE_VERSION_UNKNOWN',
      `${version} is neither drafted nor cut in this project (${draft}): name the drafted release by its version, or a release already cut.`,
      '/version',
    );
  }
  await writeRunMetadata(run.id, { merge: namingStamp(naming, by), touch: true });
  return { version, state: 'cut', runId: run.id, ...naming };
}

/**
 * The assistant's name for a release nobody named (REQ-40 BC-14): written only while the release
 * still has none, so a name a person or the master wrote meanwhile is never replaced by a draft.
 */
export async function nameUnnamedRelease(
  projectId: string,
  version: string,
  naming: ReleaseNaming,
): Promise<'named' | 'already_named'> {
  if ((await draftNaming(projectId, version)) !== null) return 'already_named';
  await nameRelease(projectId, version, naming, null);
  return 'named';
}

/** `nameRelease` as `userId`, who names a release only where they may cut one (project.admin). */
export async function nameReleaseAs(
  projectId: string,
  version: string,
  naming: ReleaseNaming,
  userId: string,
): ReturnType<typeof nameRelease> {
  requireHeld(await loadProjectAccess(projectId, userId), 'project.admin');
  return nameRelease(projectId, version, naming, userId);
}

/**
 * The draft's name, else null where every issue of `roster` reached the gate after it was written. A
 * name describes what waited when it was written, so that one named a roster that left the gate uncut
 * (catalog-api 2026-10-23: release records shipped it under no version, and a cut a week on took it).
 */
async function namingOfRoster(
  tx: Tx,
  pending: typeof releaseDraftNamings.$inferSelect,
  cut: { projectId: string; version: string; runId: string; roster: string[] },
) {
  const arrived = await arrivedAfterOf(tx, cut.roster, RELEASE_GATE_STATUS, pending.namedAt);
  if (arrived.size < new Set(cut.roster).size) return pending;
  logger.info(
    { projectId: cut.projectId, runId: cut.runId, version: cut.version, name: pending.name },
    'release naming: the draft was named before any issue this cut carries reached the gate, so the cut does not carry it',
  );
  return null;
}

/**
 * Gives the run the cut just opened as `version` its name, inside the cut's transaction: the one the
 * cut was handed, else the one its draft was given for this roster, else the name of the attempt it
 * re-cuts. The draft's row goes either way, consumed, overridden or outlived.
 */
export async function carryNaming(
  tx: Tx,
  cut: {
    projectId: string;
    version: string;
    runId: string;
    given: ReleaseNaming | null;
    by: string;
    roster: string[];
  },
): Promise<void> {
  const drafted = await pendingNaming(cut.projectId, cut.version, tx);
  const pending = drafted && !cut.given ? await namingOfRoster(tx, drafted, cut) : null;
  const earlier =
    cut.given || pending ? null : await runCutAs(cut.projectId, cut.version, tx, cut.runId);
  const stamp = cut.given
    ? namingStamp(cut.given, cut.by)
    : pending
      ? namingStamp(
          { name: pending.name, summary: pending.summary },
          pending.namedBy,
          pending.namedAt,
        )
      : earlier && readReleaseNaming(earlier.metadata)
        ? { naming: (earlier.metadata as { naming: StoredNaming }).naming }
        : null;
  if (stamp) await writeRunMetadata(cut.runId, { merge: stamp, touch: false }, tx);
  if (drafted) await tx.delete(releaseDraftNamings).where(eq(releaseDraftNamings.id, drafted.id));
}

/**
 * The releases drafted, or cut and not yet out nor ended unshipped, that carry no name: each is the
 * project master's to name (`PUT …/releases/:version/naming`), oldest first and the draft last. A
 * shipped release is history.
 */
export async function unnamedReleases(projectId: string): Promise<{ version: string }[]> {
  const [rows, drafted] = await Promise.all([
    db
      .select({ version: pipelineRuns.releaseVersion, metadata: pipelineRuns.metadata })
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.projectId, projectId),
          isNotNull(pipelineRuns.releaseVersion),
          isNull(pipelineRuns.releaseReleasedAt),
          notInArray(pipelineRuns.status, ['cancelled', 'failed']),
        ),
      )
      .orderBy(asc(pipelineRuns.createdAt)),
    draftedVersion(projectId),
  ]);
  const cut = rows.flatMap((r) =>
    r.version && r.version !== drafted && readReleaseNaming(r.metadata) === null ? [r.version] : [],
  );
  const draft = drafted && (await draftNaming(projectId, drafted)) === null ? [drafted] : [];
  return [...new Set([...cut, ...draft])].map((version) => ({ version }));
}
