import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { testSshConnection } from '../git/index.js';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { getOrgSshKey } from '../orgs/ssh-keys-service.js';
import { requireHeld } from '../permissions/index.js';
import { NO_REPOSITORY, readDeclaredSource, remoteOf } from '../project-config/source.js';
import { projectGitKeyId, projectGitPrivateKeyEnc } from './read.js';
import { clearProjectGitKey, pickProjectGitKey } from './service.js';

export const gitCredentialRoutes = new Hono<{ Variables: AuthVars }>();
gitCredentialRoutes.use('*', requireAuth(), assertEmailVerified());

const paramSchema = z.object({ projectId: z.uuid() });
const pickSchema = z.object({ sshKeyId: z.uuid() });

async function declaredRemote(projectId: string) {
  const { repository } = await readDeclaredSource(projectId);
  return { repository, remote: repository ? remoteOf(repository, 'ssh') : null };
}

gitCredentialRoutes.get(
  '/:projectId/git-credential',
  zValidator('param', paramSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const sshKeyId = await projectGitKeyId(projectId);
    if (!sshKeyId) return c.json({ configured: false as const });

    const key = await getOrgSshKey(access.orgId, sshKeyId);
    if (!key) return c.json({ configured: false as const });

    return c.json({ configured: true as const, ...(await declaredRemote(projectId)), key });
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
    requireHeld(access, 'project.admin');

    const key = await getOrgSshKey(access.orgId, sshKeyId);
    if (!key) {
      throw new HTTPException(400, {
        message: 'that key does not belong to this project’s organization',
        cause: { code: 'WRONG_ORG' },
      });
    }

    await pickProjectGitKey(projectId, sshKeyId, userId);

    logger.info({ projectId, sshKeyId }, 'git-credential: picked pool key');

    return c.json({ configured: true as const, ...(await declaredRemote(projectId)), key }, 201);
  },
);

gitCredentialRoutes.post(
  '/:projectId/git-credential/test',
  zValidator('param', paramSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    if (!isVaultConfigured()) {
      throw new HTTPException(503, {
        message: 'secret vault not configured (INTEGRATION_MASTER_KEY missing)',
        cause: { code: 'VAULT_NOT_CONFIGURED' },
      });
    }

    const privateKeyEnc = await projectGitPrivateKeyEnc(projectId);
    if (!privateKeyEnc) {
      throw new HTTPException(404, {
        message: 'no deploy key configured for this project',
        cause: { code: 'NOT_CONFIGURED' },
      });
    }

    const { remote } = await declaredRemote(projectId);
    if (!remote) {
      throw new HTTPException(400, {
        message: `${NO_REPOSITORY}, so there is no repository to test the deploy key against`,
        cause: { code: 'NO_REPOSITORY' },
      });
    }

    let privateKey: string;
    try {
      privateKey = decryptSecret(privateKeyEnc);
    } catch (err) {
      logger.error({ err, projectId }, 'git-credential: decrypt failed on connection test');
      throw new HTTPException(500, {
        message: 'failed to decrypt the stored key (vault master key may have rotated)',
        cause: { code: 'DECRYPT_FAILED' },
      });
    }

    const result = await testSshConnection(remote, privateKey);
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
    requireHeld(access, 'project.admin');

    await clearProjectGitKey(projectId);
    return c.body(null, 204);
  },
);
