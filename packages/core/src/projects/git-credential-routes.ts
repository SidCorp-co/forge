/**
 * Per-project Git access — a reference into the org's Private Keys pool
 * (ISS-628; `workspace_ssh_keys`, managed via `orgs/ssh-keys-routes.ts`).
 *
 * GET    /api/projects/:projectId/git-credential      — non-secret status:
 *        repo URL + the referenced pool key's public view. Any project member
 *        may read so they can copy the deploy key. NEVER returns the private
 *        key.
 * PUT    /api/projects/:projectId/git-credential       — admin only. Body
 *        `{ sshKeyId }` picks a key from the project's OWN org pool (a
 *        cross-org key is rejected 400 `WRONG_ORG`).
 * POST   /api/projects/:projectId/git-credential/test  — probes the
 *        referenced pool key against the project's SSH repo URL.
 * DELETE /api/projects/:projectId/git-credential        — admin only. Detaches
 *        the reference (does not delete the pool key itself).
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, workspaceSshKeys } from '../db/schema.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { testSshConnection } from '../git/ssh-keys.js';
import { decryptSecret, isVaultConfigured } from '../integrations/vault.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { getOrgSshKey } from '../orgs/ssh-keys-service.js';

export const gitCredentialRoutes = new Hono<{ Variables: AuthVars }>();
gitCredentialRoutes.use('*', requireAuth(), assertEmailVerified());

const paramSchema = z.object({ projectId: z.uuid() });
const pickSchema = z.object({ sshKeyId: z.uuid() });

gitCredentialRoutes.get(
  '/:projectId/git-credential',
  zValidator('param', paramSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'project member required');

    const [project] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });
    }

    const [ref] = await db
      .select({ sshKeyId: projectGitCredentials.sshKeyId })
      .from(projectGitCredentials)
      .where(eq(projectGitCredentials.projectId, projectId))
      .limit(1);
    if (!ref) return c.json({ configured: false as const });

    const key = await getOrgSshKey(access.orgId, ref.sshKeyId);
    if (!key) return c.json({ configured: false as const });

    return c.json({ configured: true as const, repoUrl: project.repoUrl, key });
  },
);

gitCredentialRoutes.put(
  '/:projectId/git-credential',
  zValidator('param', paramSchema),
  zValidator('json', pickSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { sshKeyId } = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const key = await getOrgSshKey(access.orgId, sshKeyId);
    if (!key) {
      throw new HTTPException(400, {
        message: 'that key does not belong to this project’s organization',
        cause: { code: 'WRONG_ORG' },
      });
    }

    const now = new Date();
    await db
      .insert(projectGitCredentials)
      .values({ projectId, sshKeyId, createdBy: userId })
      .onConflictDoUpdate({
        target: projectGitCredentials.projectId,
        set: { sshKeyId, createdBy: userId, updatedAt: now },
      });

    logger.info({ projectId, sshKeyId }, 'git-credential: picked pool key');

    const [project] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return c.json({ configured: true as const, repoUrl: project?.repoUrl ?? null, key }, 201);
  },
);

/**
 * POST /:projectId/git-credential/test — probe the project's referenced pool
 * key against its SSH repo URL (git ls-remote). Non-mutating; any project
 * member may run it. Never returns the private key. Requires the repo URL to
 * be in SSH form (the deploy key isn't used for HTTPS remotes).
 */
gitCredentialRoutes.post(
  '/:projectId/git-credential/test',
  zValidator('param', paramSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'project member required');

    if (!isVaultConfigured()) {
      throw new HTTPException(503, {
        message: 'secret vault not configured (INTEGRATION_MASTER_KEY missing)',
        cause: { code: 'VAULT_NOT_CONFIGURED' },
      });
    }

    const [project] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });
    }

    const [ref] = await db
      .select({ privateKeyEnc: workspaceSshKeys.privateKeyEnc })
      .from(projectGitCredentials)
      .innerJoin(workspaceSshKeys, eq(workspaceSshKeys.id, projectGitCredentials.sshKeyId))
      .where(eq(projectGitCredentials.projectId, projectId))
      .limit(1);
    if (!ref) {
      throw new HTTPException(404, {
        message: 'no deploy key configured for this project',
        cause: { code: 'NOT_CONFIGURED' },
      });
    }

    const repoUrl = project.repoUrl?.trim();
    if (!repoUrl || classifyGitRemote(repoUrl) !== 'ssh') {
      throw new HTTPException(400, {
        message: 'set an SSH clone URL (git@host:org/repo.git) to test the deploy key',
        cause: { code: 'NEEDS_SSH_URL' },
      });
    }

    let privateKey: string;
    try {
      privateKey = decryptSecret(ref.privateKeyEnc);
    } catch (err) {
      logger.error({ err, projectId }, 'git-credential: decrypt failed on connection test');
      throw new HTTPException(500, {
        message: 'failed to decrypt the stored key (vault master key may have rotated)',
        cause: { code: 'DECRYPT_FAILED' },
      });
    }

    const result = await testSshConnection(repoUrl, privateKey);
    logger.info({ projectId, code: result.code, ok: result.ok }, 'git-credential: connection test');
    return c.json(result);
  },
);

gitCredentialRoutes.delete(
  '/:projectId/git-credential',
  zValidator('param', paramSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    await db.delete(projectGitCredentials).where(eq(projectGitCredentials.projectId, projectId));
    return c.body(null, 204);
  },
);
