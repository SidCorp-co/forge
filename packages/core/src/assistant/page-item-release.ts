/**
 * What a release's page shows of it, as the page beside the chat (REQ-69 BC-2): its state, what it
 * carries, and whether the person may cut or decide it, read as that person reads the page.
 */

import { HTTPException } from 'hono/http-exception';
import { effectiveProjectRole } from '../lib/authz.js';
import { isRefusal } from '../lib/refusal.js';
import { holds } from '../permissions/index.js';
import { readRelease } from '../release-batch/index.js';

export async function releaseShown(
  projectId: string,
  key: string,
  userId: string,
): Promise<{
  key: string;
  meta: Record<string, unknown>;
  content: { title: unknown } & Record<string, unknown>;
} | null> {
  const access = await effectiveProjectRole(userId, projectId);
  const viewer = access
    ? {
        userId,
        agency: 'human' as const,
        isAdmin: holds(access, 'project.admin'),
        mayApprove: holds(access, 'releases.approve'),
      }
    : null;
  try {
    const r = await readRelease(projectId, key, viewer);
    return {
      key: r.version,
      meta: {
        state: r.state,
        issueCount: r.issueCount,
        awaitingApproval: r.can.decide,
        canCut: r.can.cut,
        canDecide: r.can.decide,
      },
      content: { title: r.name ?? r.version, summary: r.summary },
    };
  } catch (err) {
    if (err instanceof HTTPException && (err.status === 404 || err.status === 400)) return null;
    // a version no release wears, or one not shaped as a version, is no record of this project
    if (isRefusal(err) && err.refusals.some((x) => /^RELEASE_VERSION_/.test(x.code))) return null;
    throw err;
  }
}
