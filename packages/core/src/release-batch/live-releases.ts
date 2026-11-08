// What a person's home names of each project's live releases (ISS-1070 r10): the newest release on
// production and the newest on testing, placed exactly as the release list places them
// (`release-list-read.ts:latestLiveReleases`), with only what the home shows of each: its version,
// name, state, branch, when it went out and the keys of the issues it carried. The list's summary
// weighs every fact a release page shows (its criteria, verdicts, approvals, requirements and change
// requests): about 67 statements a project to name two releases, which the home threw away.

import type { ReleaseProduction, ReleaseState } from '@forge/contracts/releases';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerId } from '../db/read-memo.js';
import { issues } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { releaseRunsByIds } from '../pipeline/index.js';
import { readReleaseNaming } from './naming.js';
import { releaseLinesOf } from './release-cuts.js';
import { placeDraft, placeParts, productionOf, wentOutParts } from './release-read.js';
import type { Part } from './release-read-views.js';
import { currentReleaseVersion, readLineage } from './version-store.js';
import { issueIdsOf } from './versions.js';

/** One release that went out, as the home reads it. */
export interface LiveRelease {
  version: string;
  name: string | null;
  state: ReleaseState;
  /** The branch it landed on where that is not production's; null on production. */
  landedOn: string | null;
  releasedAt: string;
  /** The display keys of the issues it carried, as the release list's contents name them. */
  issueKeys: string[];
}

/** A project's newest release on production and on testing, and what production is. */
export async function latestLive(
  projectId: string,
): Promise<{ releases: LiveRelease[]; production: ReleaseProduction }> {
  const [runs, draft, lineage, current] = await Promise.all([
    wentOutParts(projectId),
    placeDraft(projectId),
    readLineage(projectId),
    currentReleaseVersion(projectId),
  ]);
  const placed = placeParts(releaseLinesOf(lineage), runs, draft);
  // the releases that went out, newest first, as `release-list-read.ts:wentOut` orders them
  const out = placed.parts
    .filter((p) => p.continuedAs === null && p.releasedAt !== null)
    .sort((a, b) => (b.releasedAt?.getTime() ?? 0) - (a.releasedAt?.getTime() ?? 0));
  const picked = [out.find((p) => p.state === 'shipped'), out.find((p) => p.state === 'landed')]
    .filter((p): p is Part => p !== undefined)
    .flatMap((p) => (p.runId ? [{ part: p, runId: p.runId }] : []));
  const [rows, production, prefix] = await Promise.all([
    releaseRunsByIds(
      projectId,
      picked.map((p) => p.runId),
    ),
    productionOf(projectId, current),
    activeIssuePrefix(projectId),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const carried = new Map(
    picked.map((p) => [p.runId, issueIdsOf(byId.get(p.runId)?.metadata ?? {})]),
  );
  const keys = await issueKeysOf(projectId, prefix, [...carried.values()].flat());
  return {
    production,
    releases: picked.map(({ part, runId }) => {
      const run = byId.get(runId);
      if (!run) throw new Error(`release ${part.version}: its run ${runId} was placed and is gone`);
      return {
        version: part.version,
        name: readReleaseNaming(run.metadata)?.name ?? null,
        state: part.state,
        landedOn: part.landedOn,
        releasedAt: (part.releasedAt as Date).toISOString(),
        issueKeys: (carried.get(runId) ?? []).flatMap((id) => keys.get(id) ?? []),
      };
    }),
  };
}

/** Each of `ids` that is an issue of the project, by its display key; an issue of another project is none. */
async function issueKeysOf(
  projectId: string,
  prefix: string | null,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await rowsPerId(
    'liveIssueKeys',
    [...new Set(ids)],
    (some) =>
      db
        .select({ id: issues.id, projectId: issues.projectId, seq: issues.issSeq })
        .from(issues)
        .where(inArray(issues.id, [...some])),
    (r) => r.id,
  );
  return new Map(
    rows
      .filter((r) => r.projectId === projectId)
      .map((r) => [r.id, r.seq != null ? formatIssueRef(prefix, r.seq) : r.id]),
  );
}
