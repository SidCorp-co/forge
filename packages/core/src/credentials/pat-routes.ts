import type { PatRefusalCode } from '@forge/contracts/pat';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { personalAccessTokens } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { declareGate } from '../middleware/declared-gate.js';
import { forgetPatThrottle } from '../middleware/require-pat.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import {
  countActivePatsForUser,
  hasLivePatNamed,
  lastFreshAuthAt,
  listPatsOf,
  mintPat,
  revokePat,
  setPatFence,
} from './pat.js';
import { coreTokenNamePrefixOf } from './pat-format.js';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_EXPLICIT_PERMISSIONS,
  PAT_FULL_NARROWING_PERMISSIONS,
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_NAMES,
  patGrantIsStated,
  patGrantIsStatedFull,
} from './pat-permissions.js';
import { tokenChanged } from './ports.js';

const refuse = refuser<PatRefusalCode>('PAT_REFUSED');

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

patRoutes.post('/pat', requireFreshAuth(5), zValidator('json', createBodySchema), async (c) => {
  const userId = c.get('userId');
  const body = c.req.valid('json');

  // What is wrong with the body is answered before what is wrong with the
  // account, so a caller at the token limit still reads which field it left
  // out rather than a limit it would have met either way.
  const permissions = body.permissions;
  if (!patGrantIsStated(permissions)) {
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
  const besideFull = permissions.filter(
    (p) => p !== PAT_PERMISSION_ALL && !PAT_FULL_NARROWING_PERMISSIONS.includes(p),
  );
  if (permissions.includes(PAT_PERMISSION_ALL) && besideFull.length > 0) {
    throw new HTTPException(400, {
      message:
        `full access already holds ${besideFull.join(', ')}: "${PAT_PERMISSION_ALL}" holds ` +
        `everything your role can do, approvals included. Send ["${PAT_PERMISSION_ALL}"] alone ` +
        `(only ${PAT_FULL_NARROWING_PERMISSIONS.join(', ')}, which narrows it, may join it), or ` +
        'name what this token needs without it.',
      cause: {
        code: 'PAT_PERMISSIONS_FULL_NOT_COMBINABLE',
        details: { sent: permissions, alreadyHeld: besideFull },
      },
    });
  }

  const fenced = (body.projectIds ?? null) !== null || Boolean(body.boundProjectId);
  const accountOnly = permissions.filter((p) =>
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
    const allowed = new Set(await loadVisibleProjectIds(userId));
    const projectId = referenced.find((pid) => !allowed.has(pid));
    if (projectId) {
      throw new HTTPException(403, {
        message: 'project not accessible',
        cause: { code: 'FORBIDDEN_PROJECT', details: { projectId } },
      });
    }
  }

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

// A token's project list is edited by its holder after mint (FB-48): the project list replaces the
// old one, whole, and every project in it must be one the holder can see. A fence is changed, never
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
    // a box's token and the tokens core mints (a workspace, a script read, an agreement) have the
    // reach core set for them: widening one would let it reach what it was minted not to
    const reserved = coreTokenNamePrefixOf(row.name);
    if (row.deviceId || reserved) {
      throw refuse(
        'PAT_REFUSED',
        `token ${row.name} is ${row.deviceId ? "a box's, whose reach follows its pairing" : `one core minted (${reserved}…)`}: only a personal token you minted has its project list edited`,
        '/id',
      );
    }
    if (row.revokedAt) {
      throw refuse('PAT_REFUSED', 'this token is revoked; mint a new one', '/id');
    }
    const grant = row.permissions ?? [];
    const accountOnly = grant.filter((p) =>
      (PAT_ACCOUNT_ONLY_PERMISSIONS as readonly string[]).includes(p),
    );
    if (accountOnly.length > 0) {
      throw refuse(
        'PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN',
        `${accountOnly.join(', ')} ${accountOnly.length === 1 ? 'is' : 'are'} account permissions, whose routes resolve no project, and this token would be fenced to projects. Mint a token without them.`,
        '/permissions',
      );
    }
    const allowed = new Set(await loadVisibleProjectIds(userId));
    const missing = [...(projectIds ?? []), ...(boundProjectId ? [boundProjectId] : [])].find(
      (pid) => !allowed.has(pid),
    );
    if (missing) {
      throw new HTTPException(403, {
        message: 'project not accessible',
        cause: { code: 'FORBIDDEN_PROJECT', details: { projectId: missing } },
      });
    }
    const updated = await setPatFence(id, userId, { projectIds, boundProjectId });
    if (!updated) throw notFound();
    forgetPatThrottle(updated.id);
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
    const userId = c.get('userId');

    const stale = () =>
      new HTTPException(403, {
        message: 'fresh authentication required',
        cause: { code: 'FRESH_AUTH_REQUIRED' },
      });

    const at = await lastFreshAuthAt(userId);
    if (!at || Date.now() - at.getTime() > minutes * 60_000) throw stale();

    await next();
  });
}
