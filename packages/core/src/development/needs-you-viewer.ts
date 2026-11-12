// Who reads needs-you and across which projects: the viewer each list's route builds, and the visible-project sweep.

import type { NeedsYouProjectDecisions } from '@forge/contracts/needs-you-decisions';
import type { ActorAgency } from '@forge/contracts/permissions';
import { NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';
import { and, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withQueryLeg } from '../db/query-timing.js';
import { readAcross } from '../db/read-memo.js';
import { projects } from '../db/schema.js';
import { effectiveProjectRole, loadVisibleProjectIds, type ProjectAccess } from '../lib/authz.js';
import { holds } from '../permissions/index.js';
import type { NeedsYouViewer } from './needs-you.js';
import { readNeedsYouDecisionsBare } from './needs-you-decisions-read.js';
import { type EvidenceGroup, withEvidence } from './needs-you-evidence.js';

/** The viewer each list's route builds for this caller, so the counts read as the lists do. */
export const needsYouViewerOf = (
  access: ProjectAccess,
  userId: string,
  agency: ActorAgency,
): NeedsYouViewer => ({
  userId,
  agency,
  isAdmin: holds(access, 'project.admin'),
  mayApprove: holds(access, 'releases.approve'),
  mayWrite: holds(access, 'project.write'),
});

/**
 * The viewer's decisions across every project they can see, each project's the one Needs you read
 * (`needs-you-decisions-read.ts:readNeedsYouDecisions`), so /attention counts what each project's own
 * Needs you page and Dashboard count (REQ-48 BC-11), with every other row it lists as the viewer's
 * (ISS-924). A project nothing waits in is left out, and so is an archived one (ISS-1216).
 */
export async function readNeedsYouAcross(
  userId: string,
  agency: ActorAgency,
  now: Date = new Date(),
  /** Narrows the visible projects to these (a workspace's, ISS-951); it never admits one more. */
  within: readonly string[] | null = null,
  /** How many of each project's decisions are carried by name: a person's few, or a read placing each (Activity). */
  cap: number = NEEDS_YOU_PERSON_CAP,
): Promise<NeedsYouProjectDecisions[]> {
  const visible = await loadVisibleProjectIds(userId);
  const ids = within ? visible.filter((id) => within.includes(id)) : visible;
  if (ids.length === 0) return [];
  const names = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    // an archived project waits on nobody (ISS-1216)
    .where(and(inArray(projects.id, ids), isNull(projects.archivedAt)));
  // every project read side by side, each fact they ask read once for all of them
  // (`db/read-memo.ts:readAcross`), so twelve projects send the statements of one
  const perProject = await readAcross(
    names,
    (p) => p.id,
    async (p): Promise<(NeedsYouProjectDecisions & { ids: EvidenceGroup['ids'] })[]> => {
      const access = await withQueryLeg('ny-access', () => effectiveProjectRole(userId, p.id));
      if (!access || !holds(access, 'project.read')) return [];
      const { read, ids } = await readNeedsYouDecisionsBare(
        p.id,
        needsYouViewerOf(access, userId, agency),
        access,
        now,
      );
      const owed = read.notDecisions.filter((n) => n.reason !== 'agent_takes');
      if (read.total === 0 && owed.length === 0) return [];
      return [
        {
          projectSlug: p.slug,
          projectName: p.name,
          total: read.total,
          waiting: read.total + owed.reduce((n, o) => n + o.count, 0),
          decisions: read.decisions.slice(0, cap),
          owed,
          ids,
        },
      ];
    },
    'needs-you-across',
  );
  // what every project's decisions rest on, in one read for all of them (REQ-48 r3 BC-15)
  const sections = perProject.flat();
  const evidenced = await withQueryLeg('ny-evidence', () => withEvidence(sections));
  return sections.map(({ ids: _ids, ...s }, i) => ({
    ...s,
    decisions: evidenced[i] ?? s.decisions,
  }));
}
