import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { effectiveProjectRole } from '../lib/authz.js';
import type { UserVars } from '../middleware/require-user.js';
import { requireOrgHeld } from '../permissions/index.js';

type UserCtx = Context<{ Variables: UserVars }>;

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export async function assertUserIsProjectOwner(c: UserCtx, projectId: string): Promise<void> {
  const user = c.get('user');
  const access = await effectiveProjectRole(user.id, projectId);
  if (!access) throw forbidden('not a project owner');
  requireOrgHeld(access.orgId, access.orgRole, 'org.admin');
}
