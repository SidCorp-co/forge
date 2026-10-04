import { SET_PAT_FENCE_SHAPE, setPatFenceRequestSchema } from '@forge/contracts/pat-fence';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { countActivePatsForUser, mintPat, revokePat, rotatePat } from '../auth/pat.js';
import { coreTokenNamePrefixOf } from '../auth/pat-format.js';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_NAMES,
  patGrantIsLegacy,
  patGrantIsStatedFull,
} from '../auth/pat-permissions.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { mcpAuditLog, personalAccessTokens } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireFreshAuth } from '../middleware/require-fresh-auth.js';
import { forgetPatThrottle } from '../middleware/require-pat.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { refused } from '../project-config/respond.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { fenceEditorRefusal, fenceOf } from './fence-rules.js';
import { listPatFenceChanges, setPatFence } from './fence-service.js';

const SCOPES = ['read', 'write', 'admin'] as const;

const createBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(SCOPES)).optional(),
    projectIds: z.array(z.uuid()).max(50).nullable().optional(),
    boundProjectId: z.uuid().nullable().optional(),
    permissions: z
      .array(z.enum([...PAT_PERMISSION_NAMES, PAT_PERMISSION_ALL]))
      .nullable()
      .optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

const rotateBodySchema = z
  .object({
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() }).strict();
const auditQuerySchema = z
  .object({ limit: z.coerce.number().int().positive().max(200).default(50) })
  .strict();

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
  const rows = await db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, userId))
    .orderBy(desc(personalAccessTokens.createdAt));
  return c.json({
    tokens: rows.map(publicShape),
    menu: {
      permissions: PAT_PERMISSION_NAMES,
      accountOnly: PAT_ACCOUNT_ONLY_PERMISSIONS,
      full: PAT_PERMISSION_ALL,
    },
  });
});

patRoutes.post(
  '/pat',
  requireFreshAuth(5),
  zValidator('json', createBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
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
    if (body.permissions.includes(PAT_PERMISSION_ALL) && body.permissions.length > 1) {
      throw new HTTPException(400, {
        message:
          `full access is the whole grant: send ["${PAT_PERMISSION_ALL}"] on its own, or name ` +
          'the permissions this token needs without it.',
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
      throw new HTTPException(400, {
        message:
          `${accountOnly.join(', ')} ${accountOnly.length === 1 ? 'is' : 'are'} account ` +
          'permissions, whose routes resolve no project, and this token is fenced to projects. ' +
          'Drop them, or mint the token with no project list.',
        cause: {
          code: 'PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN',
          details: { accountOnly, sent: body.permissions },
        },
      });
    }

    const active = await countActivePatsForUser(userId);
    if (active >= env.PAT_MAX_PER_USER) {
      throw new HTTPException(422, {
        message: 'maximum number of personal access tokens reached',
        cause: { code: 'PAT_LIMIT', details: { max: env.PAT_MAX_PER_USER } },
      });
    }

    const [existing] = await db
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.userId, userId),
          eq(personalAccessTokens.name, body.name),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .limit(1);
    if (existing) {
      throw new HTTPException(409, {
        message: 'a personal access token with this name already exists',
        cause: { code: 'PAT_NAME_CONFLICT' },
      });
    }

    const reserved = coreTokenNamePrefixOf(body.name);
    if (reserved) {
      throw new HTTPException(422, {
        message: `a token name beginning "${reserved}" is one core gives the tokens it mints for a device, a workspace or an assistant turn; name a personal token otherwise`,
        cause: { code: 'PAT_NAME_RESERVED' },
      });
    }

    if (body.boundProjectId && body.projectIds && body.projectIds.length > 0) {
      throw badRequest({
        formErrors: ['boundProjectId and projectIds are mutually exclusive'],
        fieldErrors: {},
      });
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
    if (!r.success) throw badRequest(z.flattenError(r.error));
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

patRoutes.get(
  '/pat/:id/audit',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', auditQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const [owned] = await db
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, userId)))
      .limit(1);
    if (!owned) throw notFound();
    const rows = await db
      .select({
        id: mcpAuditLog.id,
        tool: mcpAuditLog.tool,
        action: mcpAuditLog.action,
        projectId: mcpAuditLog.projectId,
        resultCode: mcpAuditLog.resultCode,
        requestId: mcpAuditLog.requestId,
        ip: mcpAuditLog.ip,
        userAgent: mcpAuditLog.userAgent,
        createdAt: mcpAuditLog.createdAt,
      })
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.tokenId, id))
      .orderBy(desc(mcpAuditLog.createdAt))
      .limit(limit);
    return c.json({ entries: rows });
  },
);

patRoutes.post(
  '/pat/:id/rotate',
  requireFreshAuth(5),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', rotateBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const minted = await rotatePat({ id, userId, expiresAt });
    if (!minted) throw notFound();
    forgetPatThrottle(id);
    roomManager.publish(userRoom(userId), {
      event: 'pat.created',
      data: { tokenId: minted.row.id, userId, rotatedFrom: id, ts: new Date().toISOString() },
    });
    roomManager.publish(userRoom(userId), {
      event: 'pat.revoked',
      data: { tokenId: id, userId, ts: new Date().toISOString() },
    });
    return c.json({ ...publicShape(minted.row), plaintext: minted.plaintext });
  },
);

patRoutes.put(
  '/pat/:id/fence',
  async (c, next) => {
    const refusal = fenceEditorRefusal(c.get('principal'));
    if (refusal) throw new RefusalError([refusal], refusal.code);
    await next();
  },
  requireFreshAuth(5),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  strictBody(setPatFenceRequestSchema, SET_PAT_FENCE_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const outcome = await setPatFence({
      tokenId: id,
      ownerId: userId,
      fence: fenceOf(body),
      reason: body.reason,
    });
    if (!outcome) {
      throw new HTTPException(404, {
        message: `no token ${id} of yours`,
        cause: { code: 'NOT_FOUND' },
      });
    }
    if (!outcome.ok) return refused(c, outcome.refusals);
    roomManager.publish(userRoom(userId), {
      event: 'pat.fence_changed',
      data: { tokenId: id, userId, changeId: outcome.change.id, ts: outcome.change.changedAt },
    });
    return c.json({ token: publicShape(outcome.token), change: outcome.change });
  },
);

patRoutes.get(
  '/pat/:id/fence-changes',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', auditQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const changes = await listPatFenceChanges(id, c.get('userId'), limit);
    if (!changes) {
      throw new HTTPException(404, {
        message: `no token ${id} of yours`,
        cause: { code: 'NOT_FOUND' },
      });
    }
    return c.json({ changes });
  },
);

async function listUserProjectIds(userId: string): Promise<string[]> {
  return loadVisibleProjectIds(userId);
}
