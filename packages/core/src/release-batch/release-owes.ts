// Who owes a release's acts (ISS-1058): the one rule (`@forge/contracts/who-owes:whoOwes`) read with
// the project's policy and what the release carries that cannot be undone, as its issues' release
// notes say it. The release standing (`release-view.ts`) and its gates' owners (`release-gates.ts`)
// ask this one answer, so a routine release act names the project's master and a release carrying an
// irreversible change names a person, on every surface that reads the release.

import type { ReleaseNotes } from '@forge/contracts/release-notes';
import {
  type OwedActKind,
  type OwedBy,
  type OwedPolicy,
  whoOwes,
} from '@forge/contracts/who-owes';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { readOwedPolicy } from '../project-config/index.js';

/** Who owes a release act of one release: read with that release's content. */
export type ReleaseOwes = (kind: OwedActKind) => OwedBy;

/** What a release's changes do that cannot be undone, each once, as their notes say it. */
export function irreversibleOf(notes: readonly (ReleaseNotes | null | undefined)[]): string[] {
  return [...new Set(notes.flatMap((n) => (n?.irreversible ? [n.irreversible] : [])))];
}

/** The one rule bound to a project's policy and one release's content. */
export const releaseOwesOf =
  (policy: OwedPolicy, irreversible: readonly string[]): ReleaseOwes =>
  (kind) =>
    whoOwes(kind, policy, { irreversible });

/** The rule for a roster not yet read with its facts (a draft's gates): its notes are read here. */
export async function readReleaseOwes(
  projectId: string,
  issueIds: readonly string[],
): Promise<ReleaseOwes> {
  const [policy, rows] = await Promise.all([
    readOwedPolicy(projectId),
    issueIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ releaseNotes: issues.releaseNotes })
          .from(issues)
          .where(inArray(issues.id, [...issueIds])),
  ]);
  return releaseOwesOf(
    policy,
    irreversibleOf(rows.map((r) => r.releaseNotes)),
  );
}
