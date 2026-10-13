import { Hono } from 'hono';
import { answer } from '../api-reference/describe.js';
import { assertOrgAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/validator.js';
import {
  createSshKey,
  createSshKeySchema,
  deleteSshKey,
  keyParamSchema,
  listSshKeys,
  orgParamSchema,
  sshConnectionTestSchema,
  sshKeyListSchema,
  sshKeyViewSchema,
  testSshKey,
  testSshKeySchema,
} from './ssh-keys-routes-reference.js';
import {
  createOrgSshKey,
  deleteOrgSshKey,
  listOrgSshKeys,
  testOrgSshKey,
} from './ssh-keys-service.js';

export const sshKeyRoutes = new Hono<{ Variables: AuthVars }>();
sshKeyRoutes.use('*', requireAuth(), assertEmailVerified());

sshKeyRoutes.get(
  '/:orgId/ssh-keys',
  listSshKeys,
  zValidator('param', orgParamSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'member');
    return c.json(answer(sshKeyListSchema, await listOrgSshKeys(orgId)));
  },
);

sshKeyRoutes.post(
  '/:orgId/ssh-keys',
  createSshKey,
  zValidator('param', orgParamSchema),
  zValidator('json', createSshKeySchema),
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
    return c.json(answer(sshKeyViewSchema, view), 201);
  },
);

sshKeyRoutes.delete(
  '/:orgId/ssh-keys/:keyId',
  deleteSshKey,
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
  testSshKey,
  zValidator('param', keyParamSchema),
  zValidator('json', testSshKeySchema),
  async (c) => {
    const { orgId, keyId } = c.req.valid('param');
    const { repoUrl } = c.req.valid('json');
    const userId = c.get('userId');
    await assertOrgAccess(orgId, userId, 'member');
    const result = await testOrgSshKey(orgId, keyId, repoUrl);
    return c.json(answer(sshConnectionTestSchema, result));
  },
);
