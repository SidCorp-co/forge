// On a project that releases by merging its change requests, work the host already holds on the
// project's target branch has nothing left to merge: it needs no change request, and it is landed
// (catalog-api 0.2.0, 2026-10-25: ISS-1 at f55026eb and ISS-3 at c988d627 were on GitLab `dev` with
// no merge request, and the release asked for one while the steward reopened ISS-3 as unlanded).
// One read, for the roster (`change-request-roster.ts`), the cut (`create.ts`) and the build a
// verdict counts on (`change-request-build.ts`), so the gate and the steward agree.

import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import { readLandingBranches, readProjectDocument } from '../project-config/index.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** Where an issue's work already is on the host: the target branch and the commit it holds. */
export interface OnTarget {
  branch: string;
  commit: string;
  /** How it was read: the host merge Forge holds, or the branch read through the binding. */
  from: 'host-merge' | 'branch';
}

/**
 * Of `issueIds` on a change-request project, those whose work the host shows is already on the
 * project's target branch (`source.git.defaultBranch`): the host merge Forge holds for it
 * (`merged_commit_sha`), or the commit its merge mark names on that branch, which the branch on the
 * host contains, read through the binding (`issues/host-mark.ts` reads a new mark the same way). A
 * mark whose commit the branch does not hold, such as one only a box's local remote ever had
 * (catalog-api ISS-12), is not landed. Empty on any other project. A host that cannot be read
 * throws, naming why, so no caller reads silence as "not landed".
 */
export async function landedOnTargetOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, OnTarget>> {
  const out = new Map<string, OnTarget>();
  const ids = [...new Set(issueIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return out;
  if (!releaseThroughChangeRequests((await readProjectDocument(projectId))?.document)) return out;
  const { defaultBranch: branch } = await readLandingBranches(projectId);
  if (!branch) return out;
  const rows = (await db.execute(sql`
    SELECT i.id::text AS id, i.merged_commit_sha AS merged, i.merged_target AS target,
           i.merged_paths ->> 'commit' AS marked
      FROM issues i
     WHERE i.project_id = ${projectId}::uuid AND i.merged_at IS NOT NULL
       AND i.id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`)) as unknown as Array<{
    id: string;
    merged: string | null;
    target: string | null;
    marked: string | null;
  }>;
  const toRead: Array<{ id: string; commit: string }> = [];
  for (const r of rows) {
    const merged = r.merged?.trim().toLowerCase() ?? '';
    if (WHOLE.test(merged)) {
      out.set(r.id, { branch, commit: merged, from: 'host-merge' });
      continue;
    }
    const marked = r.marked?.trim().toLowerCase() ?? '';
    if (WHOLE.test(marked) && (r.target === null || r.target === branch)) {
      toRead.push({ id: r.id, commit: marked });
    }
  }
  if (toRead.length === 0) return out;
  const host = await resolveSourceHost(projectId, 'kernel');
  for (const { id, commit } of toRead) {
    if (await host.branchContains(branch, commit)) out.set(id, { branch, commit, from: 'branch' });
  }
  return out;
}

/** "already on `dev` at `f55026ebac52`": how every reader names such an issue. */
export function alreadyOnPhrase(key: string, on: OnTarget): string {
  return `${key} is already on \`${on.branch}\` on its host at \`${on.commit.slice(0, 12)}\`, with no change request left to merge`;
}
