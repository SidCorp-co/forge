/**
 * Personal Access Token REST surface (ISS-150).
 *
 * Mounted under `/api/pat`. All routes require an authenticated, email-verified
 * user (browser JWT or Authorization: Bearer JWT). The MCP middleware
 * (`require-pat-or-device.ts`) handles PAT use for MCP traffic — these routes
 * are user-management only.
 *
 *   POST   /api/pat              — mint (returns plaintext exactly once)
 *   GET    /api/pat              — list (no plaintext, no hash)
 *   DELETE /api/pat/:id          — revoke (idempotent)
 *   GET    /api/pat/:id/audit    — recent uses (last N rows of mcp_audit_log)
 *   POST   /api/pat/:id/rotate   — mint new plaintext, revoke old
 */

import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  countActivePatsForUser,
  mintPat,
  revokePat,
  rotatePat,
} from '../auth/pat.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import {
  mcpAuditLog,
  personalAccessTokens,
  projectMembers,
  projects,
} from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireFreshAuth } from '../middleware/require-fresh-auth.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

const SCOPES = ['read', 'write'] as const;

const createBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(SCOPES)).optional(),
    projectIds: z.array(z.uuid()).max(50).nullable().optional(),
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

function publicShape(row: typeof personalAccessTokens.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
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
  return c.json({ tokens: rows.map(publicShape) });
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

    // Per-user cap.
    const active = await countActivePatsForUser(userId);
    if (active >= env.PAT_MAX_PER_USER) {
      throw new HTTPException(422, {
        message: 'maximum number of personal access tokens reached',
        cause: { code: 'PAT_LIMIT', details: { max: env.PAT_MAX_PER_USER } },
      });
    }

    // Name uniqueness check (the DB also enforces this — we pre-check to give
    // a clean 409 instead of a 500 on the unique-index violation).
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

    // projectIds — every entry must be a project the user can access.
    if (body.projectIds && body.projectIds.length > 0) {
      const allowed = await listUserProjectIds(userId);
      const allowedSet = new Set(allowed);
      for (const pid of body.projectIds) {
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
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    // Body is optional: empty payload accepted; if present, must match the
    // schema. We parse manually so an empty body doesn't 400.
    let expiresAt: Date | null = null;
    try {
      const raw = await c.req.json().catch(() => null);
      if (raw && typeof raw === 'object') {
        const parsed = rotateBodySchema.safeParse(raw);
        if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
        if (parsed.data.expiresAt) expiresAt = new Date(parsed.data.expiresAt);
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      // body wasn't JSON — treat as empty.
    }
    const minted = await rotatePat({ id, userId, expiresAt });
    if (!minted) throw notFound();
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

async function listUserProjectIds(userId: string): Promise<string[]> {
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.ownerId, userId));
  const member = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
  const ids = new Set<string>();
  for (const row of owned) ids.add(row.id);
  for (const row of member) ids.add(row.id);
  return [...ids];
}
