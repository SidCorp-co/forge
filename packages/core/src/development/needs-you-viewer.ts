// Who reads needs-you and across which projects: the viewer each list's route builds, and the visible-project sweep.

import type { NeedsYouProjectItem } from '@forge/contracts/needs-you';
import type { ActorAgency } from '@forge/contracts/permissions';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { effectiveProjectRole, loadVisibleProjectIds, type ProjectAccess } from '../lib/authz.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { holds } from '../permissions/index.js';
import { type NeedsYouViewer, readNeedsYou } from './needs-you.js';

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
});

/**
 * How many projects the cross-project read assembles at once. Each project's read sends its lists'
 * statements in parallel, and every page load asks for this count: unbounded, eight projects queued
 * a few hundred statements ahead of the page's own reads on the ten-connection pool.
 */
export const NEEDS_YOU_ACROSS_CONCURRENCY = 2;

/** The same rows across every project the viewer can see, each project read by `readNeedsYou`. */
export async function readNeedsYouAcross(
  userId: string,
  agency: ActorAgency,
  now: Date = new Date(),
): Promise<NeedsYouProjectItem[]> {
  const ids = await loadVisibleProjectIds(userId);
  if (ids.length === 0) return [];
  const names = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, ids));
  const limiter = createLimiter(NEEDS_YOU_ACROSS_CONCURRENCY);
  const perProject = await Promise.all(
    names.map((p) =>
      limiter.run(async () => {
        const access = await effectiveProjectRole(userId, p.id);
        if (!access || !holds(access, 'project.read')) return [];
        const read = await readNeedsYou(p.id, needsYouViewerOf(access, userId, agency), now);
        return read.items.map((i) => ({ ...i, projectSlug: p.slug, projectName: p.name }));
      }),
    ),
  );
  return perProject.flat();
}
