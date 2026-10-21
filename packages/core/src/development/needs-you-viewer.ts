// Who reads needs-you and across which projects: the viewer each list's route builds, and the visible-project sweep.

import type { NeedsYouProjectDecisions } from '@forge/contracts/needs-you-decisions';
import type { ActorAgency } from '@forge/contracts/permissions';
import { NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { effectiveProjectRole, loadVisibleProjectIds, type ProjectAccess } from '../lib/authz.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { holds } from '../permissions/index.js';
import type { NeedsYouViewer } from './needs-you.js';
import { readNeedsYouDecisions } from './needs-you-decisions.js';
import { primeNeedsYouAcross } from './needs-you-fold.js';

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
 * How many projects the cross-project read assembles at once. Each project's read sends its lists'
 * statements in parallel, and every page load asks for this count: unbounded, eight projects queued
 * a few hundred statements ahead of the page's own reads on the ten-connection pool.
 */
export const NEEDS_YOU_ACROSS_CONCURRENCY = 2;

/**
 * The viewer's decisions across every project they can see, each project's the one Needs you read
 * (`needs-you-decisions.ts:readNeedsYouDecisions`), so /attention counts what each project's own
 * Needs you page and Dashboard count (REQ-48 BC-11). A project nothing waits in is left out.
 */
export async function readNeedsYouAcross(
  userId: string,
  agency: ActorAgency,
  now: Date = new Date(),
): Promise<NeedsYouProjectDecisions[]> {
  const ids = await loadVisibleProjectIds(userId);
  if (ids.length === 0) return [];
  const names = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, ids));
  // the rows every project's read sends once, read for all of them at once
  primeNeedsYouAcross(names.map((p) => p.id));
  const limiter = createLimiter(NEEDS_YOU_ACROSS_CONCURRENCY);
  const perProject = await Promise.all(
    names.map((p) =>
      limiter.run(async (): Promise<NeedsYouProjectDecisions[]> => {
        const access = await effectiveProjectRole(userId, p.id);
        if (!access || !holds(access, 'project.read')) return [];
        const read = await readNeedsYouDecisions(
          p.id,
          needsYouViewerOf(access, userId, agency),
          access,
          now,
        );
        if (read.total === 0) return [];
        return [
          {
            projectSlug: p.slug,
            projectName: p.name,
            total: read.total,
            decisions: read.decisions.slice(0, NEEDS_YOU_PERSON_CAP),
          },
        ];
      }),
    ),
  );
  return perProject.flat();
}
