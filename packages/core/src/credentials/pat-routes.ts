import type { PatRefusalCode } from '@forge/contracts/pat';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { personalAccessTokens } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { roomManager, userRoom } from '../lib/rooms.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireFreshAuth } from '../middleware/require-fresh-auth.js';
import { forgetPatThrottle } from '../middleware/require-pat.js';
import { zValidator } from '../middleware/zod-validator.js';
import { countActivePatsForUser, mintPat, revokePat } from './pat.js';
import { coreTokenNamePrefixOf } from './pat-format.js';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_EXPLICIT_PERMISSIONS,
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_NAMES,
  patGrantIsLegacy,
  patGrantIsStatedFull,
} from './pat-permissions.js';
import { hasLivePatNamed, listPatsOf } from './pat-read.js';

const refuse = refuser<PatRefusalCode>('PAT_REFUSED');

const SCOPES = ['read', 'write', 'admin'] as const;

const createBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(SCOPES)).optional(),
    projectIds: z.array(z.uuid()).max(50).nullable().optional(),
    boundProjectId: z.uuid().nullable().optional(),
    permissions: z
      .array(z.enum([...PAT_PERMISSION_NAMES, ...PAT_EXPLICIT_PERMISSIONS, PAT_PERMISSION_ALL]))
      .nullable()
      .optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
const idParamSchema = z.object({ id: z.uuid() }).strict();
const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'not found', cause: { code: 'NOT_FOUND' } });

/**
 * Which of the three grants a row carries, read once here so a listing does
 * not have to work it out from the array and reach a different answer.
 */
function grantOf(permissions: string[] | null): 'legacy' | 'full' | 'named' {
  if (patGrantIsLegacy(permissions)) return 'legacy';
  return patGrantIsStatedFull(permissions) ? 'full' : 'named';
}

function publicShape(row: typeof personalAccessTokens.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
    permissions: row.permissions ?? null,
    grant: grantOf(row.permissions ?? null),
    boundProjectId: row.boundProjectId ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
  };
}

export const patRoutes = new Hono<{ Variables: AuthVars }>();

patRoutes.use('/pat', requireAuth(), assertEmailVerified());
patRoutes.use('/pat/*', requireAuth(), assertEmailVerified());

patRoutes.get('/pat', async (c) => {
  const userId = c.get('userId');
  const rows = await listPatsOf(userId);
  return c.json({
    tokens: rows.map(publicShape),
    menu: {
      permissions: PAT_PERMISSION_NAMES,
      accountOnly: PAT_ACCOUNT_ONLY_PERMISSIONS,
      explicit: PAT_EXPLICIT_PERMISSIONS,
      full: PAT_PERMISSION_ALL,
    },
  });
});

patRoutes.post(
  '/pat',
  requireFreshAuth(5),
  zValidator('json', createBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');

    // What is wrong with the body is answered before what is wrong with the
    // account, so a caller at the token limit still reads which field it left
    // out rather than a limit it would have met either way.
    if (!body.permissions || body.permissions.length === 0) {
      throw new HTTPException(400, {
        message:
          'a token states what it may reach: send `permissions` naming the groups this token ' +
          `needs, or ["${PAT_PERMISSION_ALL}"] for full access chosen on purpose. An omitted ` +
          'grant used to mint a token reaching the whole menu, and no longer does.',
        cause: {
          code: 'PAT_PERMISSIONS_REQUIRED',
          details: { menu: PAT_PERMISSION_NAMES, full: [PAT_PERMISSION_ALL] },
        },
      });
    }
    const routeGroups = body.permissions.filter(
      (p) => !(PAT_EXPLICIT_PERMISSIONS as readonly string[]).includes(p),
    );
    if (body.permissions.includes(PAT_PERMISSION_ALL) && routeGroups.length > 1) {
      throw new HTTPException(400, {
        message:
          `full access is the whole route grant: send ["${PAT_PERMISSION_ALL}"] with no route ` +
          `group beside it (only ${PAT_EXPLICIT_PERMISSIONS.join(', ')} may join it), or name ` +
          'the groups this token needs without it.',
        cause: {
          code: 'PAT_PERMISSIONS_FULL_NOT_COMBINABLE',
          details: { sent: body.permissions },
        },
      });
    }

    const fenced = (body.projectIds ?? null) !== null || Boolean(body.boundProjectId);
    const accountOnly = body.permissions.filter((p) =>
      (PAT_ACCOUNT_ONLY_PERMISSIONS as readonly string[]).includes(p),
    );
    if (fenced && accountOnly.length > 0) {
      throw refuse(
        'PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN',
        `${accountOnly.join(', ')} ${accountOnly.length === 1 ? 'is' : 'are'} account ` +
          'permissions, whose routes resolve no project, and this token is fenced to projects. ' +
          'Drop them, or mint the token with no project list.',
        '/permissions',
      );
    }

    const active = await countActivePatsForUser(userId);
    if (active >= env.PAT_MAX_PER_USER) {
      throw refuse(
        'PAT_LIMIT',
        `you hold the most live personal access tokens allowed (${env.PAT_MAX_PER_USER}); revoke one first`,
      );
    }

    if (await hasLivePatNamed(userId, body.name)) {
      throw refuse(
        'PAT_NAME_CONFLICT',
        'a live personal access token with this name already exists',
        '/name',
      );
    }

    const reserved = coreTokenNamePrefixOf(body.name);
    if (reserved) {
      throw refuse(
        'PAT_NAME_RESERVED',
        `a token name beginning "${reserved}" is one core gives the tokens it mints for a device, a workspace or an assistant turn; name a personal token otherwise`,
        '/name',
      );
    }

    if (body.boundProjectId && body.projectIds && body.projectIds.length > 0) {
      throw badRequest('boundProjectId and projectIds are mutually exclusive');
    }

    const referenced = [
      ...(body.projectIds ?? []),
      ...(body.boundProjectId ? [body.boundProjectId] : []),
    ];
    if (referenced.length > 0) {
      const allowed = await listUserProjectIds(userId);
      const allowedSet = new Set(allowed);
      for (const pid of referenced) {
        if (!allowedSet.has(pid)) {
          throw new HTTPException(403, {
            message: 'project not accessible',
            cause: { code: 'FORBIDDEN_PROJECT', details: { projectId: pid } },
          });
        }
      }
    }

    const minted = await mintPat({
      userId,
      name: body.name,
      scopes: body.scopes,
      projectIds: body.projectIds ?? null,
      boundProjectId: body.boundProjectId ?? null,
      permissions: body.permissions,
      grantEpoch: PAT_GRANT_EPOCH,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });

    roomManager.publish(userRoom(userId), {
      event: 'pat.created',
      data: { tokenId: minted.row.id, userId, ts: new Date().toISOString() },
    });

    return c.json(
      {
        ...publicShape(minted.row),
        plaintext: minted.plaintext,
      },
      201,
    );
  },
);

patRoutes.delete(
  '/pat/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const row = await revokePat(id, userId);
    if (!row) throw notFound();
    forgetPatThrottle(row.id);
    roomManager.publish(userRoom(userId), {
      event: 'pat.revoked',
      data: { tokenId: row.id, userId, ts: new Date().toISOString() },
    });
    return c.json(publicShape(row));
  },
);

async function listUserProjectIds(userId: string): Promise<string[]> {
  return loadVisibleProjectIds(userId);
}
