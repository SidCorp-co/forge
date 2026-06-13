/**
 * Per-project git SSH deploy-key management (optional).
 *
 * GET    /api/projects/:projectId/git-credential  — non-secret status (source,
 *        public key, fingerprint). Any project member may read so they can copy
 *        the deploy key. NEVER returns the private key.
 * POST   /api/projects/:projectId/git-credential  — admin only. `generate` mints
 *        a fresh ed25519 pair; `provide` stores a user-pasted private key. The
 *        private key is vault-encrypted at rest; the response returns only the
 *        public half + fingerprint.
 * DELETE /api/projects/:projectId/git-credential  — admin only. Removes the key
 *        (devices fall back to whatever git auth they already have).
 *
 * Storing a private key server-side is a deliberate, opt-in exception to the
 * ISS-305 "never persist git secrets" rule — it's what lets one deploy key scale
 * to N runners. It is gated by the vault (INTEGRATION_MASTER_KEY); without the
 * key configured the write paths return 503 rather than storing plaintext.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projectGitCredentials, projects } from '../db/schema.js';
import { derivePublicFromPrivate, generateSshKeypair } from '../git/ssh-keys.js';
import { encryptSecret, isVaultConfigured } from '../integrations/vault.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

export const gitCredentialRoutes = new Hono<{ Variables: AuthVars }>();
gitCredentialRoutes.use('*', requireAuth(), assertEmailVerified());

const paramSchema = z.object({ projectId: z.uuid() });

const upsertSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('generate') }),
  z.object({
    mode: z.literal('provide'),
    privateKey: z.string().min(1).max(20000),
  }),
]);

/** Shape every response on this route (and the device delivery) shares. */
function publicView(row: {
  source: string;
  publicKey: string;
  fingerprint: string | null;
  createdAt: Date;
}) {
  return {
    configured: true as const,
    source: row.source,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

gitCredentialRoutes.get(
  '/:projectId/git-credential',
  zValidator('param', paramSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'project member required');

    const [row] = await db
      .select({
        source: projectGitCredentials.source,
        publicKey: projectGitCredentials.publicKey,
        fingerprint: projectGitCredentials.fingerprint,
        createdAt: projectGitCredentials.createdAt,
      })
      .from(projectGitCredentials)
      .where(eq(projectGitCredentials.projectId, projectId))
      .limit(1);

    return c.json(row ? publicView(row) : { configured: false as const });
  },
);

gitCredentialRoutes.post(
  '/:projectId/git-credential',
  zValidator('param', paramSchema),
  zValidator('json', upsertSchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    if (!isVaultConfigured()) {
      throw new HTTPException(503, {
        message: 'secret vault not configured (INTEGRATION_MASTER_KEY missing)',
        cause: { code: 'VAULT_NOT_CONFIGURED' },
      });
    }

    const [project] = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });
    }

    const comment = `forge-${project.slug}`;
    let keypair: { publicKey: string; privateKey: string; fingerprint: string };
    let source: 'forge_generated' | 'user_provided';
    try {
      if (body.mode === 'generate') {
        keypair = await generateSshKeypair(comment);
        source = 'forge_generated';
      } else {
        keypair = await derivePublicFromPrivate(body.privateKey, comment);
        source = 'user_provided';
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('invalid_private_key')) {
        throw new HTTPException(400, { message: msg, cause: { code: 'INVALID_PRIVATE_KEY' } });
      }
      logger.error({ err, projectId }, 'git-credential: keypair build failed');
      throw new HTTPException(500, {
        message: 'failed to build SSH keypair',
        cause: { code: 'KEYPAIR_FAILED' },
      });
    }

    const privateKeyEnc = encryptSecret(keypair.privateKey);
    const now = new Date();
    const [row] = await db
      .insert(projectGitCredentials)
      .values({
        projectId,
        source,
        publicKey: keypair.publicKey,
        privateKeyEnc,
        fingerprint: keypair.fingerprint,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: projectGitCredentials.projectId,
        set: {
          source,
          publicKey: keypair.publicKey,
          privateKeyEnc,
          fingerprint: keypair.fingerprint,
          createdBy: userId,
          updatedAt: now,
        },
      })
      .returning({
        source: projectGitCredentials.source,
        publicKey: projectGitCredentials.publicKey,
        fingerprint: projectGitCredentials.fingerprint,
        createdAt: projectGitCredentials.createdAt,
      });

    if (!row) {
      throw new HTTPException(500, {
        message: 'git-credential upsert returned no row',
        cause: { code: 'UPSERT_FAILED' },
      });
    }
    logger.info({ projectId, source }, 'git-credential: upserted project SSH key');
    return c.json(publicView(row), 201);
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
