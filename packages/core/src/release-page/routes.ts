// `GET /api/projects/:projectId/releases/:version/page?view=user|developer` — one release as a
// reader reads it (REQ-40), at `@forge/contracts/release-page:releasePagePath`. Anyone who can read
// the project reads both views; the developer view only adds technical notes.

import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import { type PageViewer, readReleasePage } from './read.js';
import { refreshInBackground } from './refresh.js';

export const releasePageRoutes = new Hono<{ Variables: AuthVars }>();
releasePageRoutes.use('/:projectId/releases/:version/page', requireAuth(), assertEmailVerified());

const pageParam = zValidator(
  'param',
  z.object({ projectId: z.uuid(), version: z.string().min(1).max(40) }),
);

// the view is read as written, so a view the page does not have is refused by its own code
const pageQuery = zValidator('query', z.object({ view: z.string().max(40).optional() }));

releasePageRoutes.get('/:projectId/releases/:version/page', pageParam, pageQuery, async (c) => {
  const { projectId, version } = c.req.valid('param');
  const { view = 'user' } = c.req.valid('query');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  requireHeld(access, 'project.read');
  const userId = c.get('userId');
  const agency = c.get('agency');
  const viewer: PageViewer =
    typeof userId === 'string' && (agency === 'human' || agency === 'agent')
      ? {
          userId,
          agency,
          isAdmin: holds(access, 'project.admin'),
          mayApprove: holds(access, 'releases.approve'),
          mayShare: holds(access, 'shares.write'),
        }
      : null;
  return c.json(
    await readReleasePage({
      projectId,
      version,
      view,
      viewer,
      onOwed: refreshInBackground,
    }),
  );
});
