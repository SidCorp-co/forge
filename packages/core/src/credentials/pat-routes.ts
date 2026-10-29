import type { PatRefusalCode } from '@forge/contracts/pat';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { personalAccessTokens } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { declareGate } from '../middleware/declared-gate.js';
import { forgetPatThrottle } from '../middleware/require-pat.js';
import { badRequest } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { hasLivePatNamed, listPatsOf, mintPat, revokePat, setPatFence } from './pat.js';
import { coreTokenNamePrefixOf } from './pat-format.js';
import {
  assertFreshAuth,
  assertProjectsVisible,
  assertUnderTokenLimit,
  mintableGrant,
  patMenu,
  refusePat,
} from './pat-grant-checks.js';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_EXPLICIT_PERMISSIONS,
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_NAMES,
  patGrantIsStated,
  patGrantIsStatedFull,
} from './pat-permissions.js';
import { tokenChanged } from './ports.js';

const refuse = refusePat;

const SCOPES = ['read', 'write'] as const;

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
const fenceBodySchema = z
  .object({
    projectIds: z.array(z.uuid()).min(1).max(50).nullable().optional(),
    boundProjectId: z.uuid().nullable().optional(),
  })
  .strict();
const idParamSchema = z.object({ id: z.uuid() }).strict();
const notFound = () =>
  new HTTPException(404, { message: 'not found', cause: { code: 'NOT_FOUND' } });

/**
 * Which of the three grants a row carries, read once here so a listing does
 * not have to work it out from the array and reach a different answer. An
 * `unstated` row reaches nothing: every door refuses it as `PAT_GRANT_UNSTATED`.
 */
function grantOf(permissions: string[] | null): 'unstated' | 'full' | 'named' {
  if (!patGrantIsStated(permissions)) return 'unstated';
  return patGrantIsStatedFull(permissions) ? 'full' : 'named';
}

type PatRow = typeof personalAccessTokens.$inferSelect;

/**
 * Why this token's project list cannot be edited, or null where it can (FB-48): a box's token and
 * the tokens core mints have the reach core set for them, a revoked one reaches nothing, and an
 * account permission resolves no project.
 */
function fenceFixed(row: PatRow): { code: PatRefusalCode; path: string; detail: string } | null {
  const reserved = coreTokenNamePrefixOf(row.name);
  if (row.deviceId || reserved)
    return {
      code: 'PAT_REFUSED',
      path: '/id',
      detail: `token ${row.name} is ${row.deviceId ? "a box's, whose reach follows its pairing" : `one core minted (${reserved}…)`}: only a personal token you minted has its project list edited`,
    };
  if (row.revokedAt)
    return { code: 'PAT_REFUSED', path: '/id', detail: 'this token is revoked; mint a new one' };
  const accountOnly = (row.permissions ?? []).filter((p) =>
    (PAT_ACCOUNT_ONLY_PERMISSIONS as readonly string[]).includes(p),
  );
  if (accountOnly.length > 0)
    return {
      code: 'PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN',
      path: '/permissions',
      detail: `${accountOnly.join(', ')} ${accountOnly.length === 1 ? 'is' : 'are'} account permissions, whose routes resolve no project, and this token would be fenced to projects. Mint a token without them.`,
    };
  return null;
}

function publicShape(row: PatRow) {
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
    fenceEditable: fenceFixed(row) === null,
  };
}

export const patRoutes = new Hono<{ Variables: AuthVars }>();

patRoutes.use('/pat', requireAuth(), assertEmailVerified());
patRoutes.use('/pat/*', requireAuth(), assertEmailVerified());

patRoutes.get('/pat', noQuery, async (c) => {
  const userId = c.get('userId');
  const rows = await listPatsOf(userId);
  return c.json({
    tokens: rows.map(publicShape),
    menu: patMenu(),
  });
});

patRoutes.post('/pat', requireFreshAuth(5), zValidator('json', createBodySchema), async (c) => {
  const userId = c.get('userId');
  const body = c.req.valid('json');

  // What is wrong with the body is answered before what is wrong with the
  // account, so a caller at the token limit still reads which field it left
  // out rather than a limit it would have met either way.
  const fenced = (body.projectIds ?? null) !== null || Boolean(body.boundProjectId);
  const permissions = mintableGrant(body.permissions, fenced);
  await assertUnderTokenLimit(userId);

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
      `a token name beginning "${reserved}" is one core gives the tokens it mints for a device, a workspace, an assistant turn or an MCP client's sign-in; name a personal token otherwise`,
      '/name',
    );
  }

  if (body.boundProjectId && body.projectIds && body.projectIds.length > 0) {
    throw badRequest('boundProjectId and projectIds are mutually exclusive');
  }

  await assertProjectsVisible(userId, [
    ...(body.projectIds ?? []),
    ...(body.boundProjectId ? [body.boundProjectId] : []),
  ]);

  const minted = await mintPat({
    userId,
    name: body.name,
    scopes: body.scopes,
    projectIds: body.projectIds ?? null,
    boundProjectId: body.boundProjectId ?? null,
    permissions,
    grantEpoch: PAT_GRANT_EPOCH,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
  });

  await tokenChanged({
    userId,
    tokenId: minted.row.id,
    change: 'created',
    ts: new Date().toISOString(),
  });

  return c.json(
    {
      ...publicShape(minted.row),
      plaintext: minted.plaintext,
    },
    201,
  );
});

// A token's project list is edited by its holder after mint (FB-48), behind a fresh sign-in, keeping
// its secret: the project list replaces the old one, whole, every project in it must be one the
// holder can see, and the change is recorded (`setPatFence`). A fence is changed or added, never
// removed, so a fenced token cannot become one that reaches everything.
patRoutes.patch(
  '/pat/:id',
  requireFreshAuth(5),
  zValidator('param', idParamSchema),
  zValidator('json', fenceBodySchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const projectIds = body.projectIds ?? null;
    const boundProjectId = body.boundProjectId ?? null;
    if (projectIds === null && boundProjectId === null) {
      throw refuse(
        'PAT_REFUSED',
        'send `projectIds` (one or more project uuids) or `boundProjectId`; a token fence is changed, never removed, so mint a token with no project list to reach everything',
        '/projectIds',
      );
    }
    if (boundProjectId && projectIds) {
      throw badRequest('boundProjectId and projectIds are mutually exclusive');
    }
    const row = (await listPatsOf(userId)).find((t) => t.id === id);
    if (!row) throw notFound();
    const fixed = fenceFixed(row);
    if (fixed) throw refuse(fixed.code, fixed.detail, fixed.path);
    await assertProjectsVisible(userId, [
      ...(projectIds ?? []),
      ...(boundProjectId ? [boundProjectId] : []),
    ]);
    const updated = await setPatFence(id, userId, { projectIds, boundProjectId });
    if (!updated) throw notFound();
    forgetPatThrottle(updated.id);
    await tokenChanged({
      userId,
      tokenId: updated.id,
      change: 'fenced',
      ts: new Date().toISOString(),
    });
    return c.json(publicShape(updated));
  },
);

patRoutes.delete('/pat/:id', zValidator('param', idParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const row = await revokePat(id, userId);
  if (!row) throw notFound();
  forgetPatThrottle(row.id);
  await tokenChanged({
    userId,
    tokenId: row.id,
    change: 'revoked',
    ts: new Date().toISOString(),
  });
  return c.json(publicShape(row));
});

function requireFreshAuth(minutes = 5): MiddlewareHandler<{ Variables: AuthVars }> {
  return declareGate('requireFreshAuth', async (c, next) => {
    await assertFreshAuth(c.get('userId'), minutes);
    await next();
  });
}
