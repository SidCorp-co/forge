/**
 * Org-scoped Private Keys pool (ISS-628) — workspace resource, first of the
 * planned resource types.
 *
 * GET    /api/orgs/:orgId/ssh-keys              — member. Non-secret list +
 *        `usedByProjects`. NEVER returns the private key.
 * POST   /api/orgs/:orgId/ssh-keys              — admin. `generate` mints a
 *        fresh ed25519 pair; `provide` stores a user-pasted private key.
 * DELETE /api/orgs/:orgId/ssh-keys/:keyId       — admin. Safe-delete: 409 +
 *        referencing-project list when the key is in use (server-side, not
 *        UI-only — see ssh-keys-service.ts).
 * POST   /api/orgs/:orgId/ssh-keys/:keyId/test  — member. Probe reachability
 *        against a caller-supplied repo URL (git ls-remote).
 */
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { assertOrgAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  createOrgSshKey,
  deleteOrgSshKey,
  listOrgSshKeys,
  testOrgSshKey,
} from './ssh-keys-service.js';

export const sshKeyRoutes = new Hono<{ Variables: AuthVars }>();
sshKeyRoutes.use('*', requireAuth(), assertEmailVerified());

const orgParamSchema = z.object({ orgId: z.uuid() });
const keyParamSchema = z.object({ orgId: z.uuid(), keyId: z.uuid() });

const createSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('generate'),
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).nullable().optional(),
  }),
  z.object({
    mode: z.literal('provide'),
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).nullable().optional(),
    privateKey: z.string().min(1).max(20000),
  }),
]);

const testSchema = z.object({ repoUrl: z.string().trim().min(1).max(2000) });

sshKeyRoutes.get('/:orgId/ssh-keys', zValidator('param', orgParamSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const userId = c.get('userId');
  await assertOrgAccess(orgId, userId, 'member');
  return c.json(await listOrgSshKeys(orgId));
});

sshKeyRoutes.post(
  '/:orgId/ssh-keys',
  zValidator('param', orgParamSchema),
  zValidator('json', createSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'admin');
    // Normalize `note` (zod leaves it possibly `undefined` when omitted) to the
    // contract's `string | null` before handing off to the service.
    const input =
      body.mode === 'generate'
        ? { mode: 'generate' as const, name: body.name, note: body.note ?? null }
        : {
            mode: 'provide' as const,
            name: body.name,
            note: body.note ?? null,
            privateKey: body.privateKey,
          };
    const view = await createOrgSshKey(orgId, userId, input);
    return c.json(view, 201);
  },
);

sshKeyRoutes.delete(
  '/:orgId/ssh-keys/:keyId',
  zValidator('param', keyParamSchema),
  async (c) => {
    const { orgId, keyId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'admin');
    await deleteOrgSshKey(orgId, keyId);
    return c.body(null, 204);
  },
);

sshKeyRoutes.post(
  '/:orgId/ssh-keys/:keyId/test',
  zValidator('param', keyParamSchema),
  zValidator('json', testSchema),
  async (c) => {
    const { orgId, keyId } = c.req.valid('param');
    const { repoUrl } = c.req.valid('json');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'member');
    const result = await testOrgSshKey(orgId, keyId, repoUrl);
    return c.json(result);
  },
);
