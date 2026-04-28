import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, ilike, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { activityLog, type DeviceStatus, deviceStatuses, devices, projectMembers, projects, users } from '../db/schema.js';
import { buildIlikePattern } from '../issues/search.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/require-admin.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
});

const devicesQuerySchema = paginationSchema.extend({
  status: z.enum(deviceStatuses).optional(),
});

const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().min(1).max(100).optional(),
  actorId: z.uuid().optional(),
  since: z.iso.datetime().optional(),
});

export const adminRoutes = new Hono<{ Variables: AuthVars }>();

// The whoami check must run under requireAuth but NOT under requireAdmin —
// it's what the client uses to discover whether it *is* an admin. Separate
// mount below.

const adminProtected = new Hono<{ Variables: AuthVars }>();
adminProtected.use('*', requireAuth(), assertEmailVerified(), requireAdmin());

adminProtected.get(
  '/users',
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, offset, q } = c.req.valid('query');
    const where = q ? ilike(users.email, buildIlikePattern(q)) : undefined;

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users).where(where);
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    setTotalCount(c, Number(n));
    return c.json(rows);
  },
);

adminProtected.get(
  '/projects',
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, offset, q } = c.req.valid('query');
    const pattern = q ? buildIlikePattern(q) : undefined;

    const countWhere = pattern
      ? sql`${projects.slug} ILIKE ${pattern} ESCAPE '\\' OR ${projects.name} ILIKE ${pattern} ESCAPE '\\'`
      : undefined;
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(projects).where(countWhere);

    const memberCountSq = db
      .select({
        projectId: projectMembers.projectId,
        n: count().as('member_count'),
      })
      .from(projectMembers)
      .groupBy(projectMembers.projectId)
      .as('mc');

    const rows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        ownerId: projects.ownerId,
        ownerEmail: users.email,
        memberCount: memberCountSq.n,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .leftJoin(users, eq(users.id, projects.ownerId))
      .leftJoin(memberCountSq, eq(memberCountSq.projectId, projects.id))
      .where(countWhere)
      .orderBy(desc(projects.createdAt))
      .limit(limit)
      .offset(offset);

    setTotalCount(c, Number(n));
    return c.json(
      rows.map((r) => ({
        ...r,
        memberCount: Number(r.memberCount ?? 0),
      })),
    );
  },
);

adminProtected.get(
  '/devices',
  zValidator('query', devicesQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, offset, status } = c.req.valid('query');
    const where = status ? eq(devices.status, status as DeviceStatus) : undefined;

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(devices).where(where);
    const rows = await db
      .select()
      .from(devices)
      .where(where)
      .orderBy(desc(devices.createdAt))
      .limit(limit)
      .offset(offset);

    setTotalCount(c, Number(n));
    return c.json(rows);
  },
);

adminProtected.get(
  '/audit',
  zValidator('query', auditQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, offset, action, actorId, since } = c.req.valid('query');

    const where: ReturnType<typeof and>[] = [];
    if (action) where.push(eq(activityLog.action, action));
    if (actorId) where.push(eq(activityLog.actorId, actorId));
    if (since) where.push(sql`${activityLog.createdAt} >= ${new Date(since)}`);
    const whereExpr = where.length === 0 ? undefined : where.length === 1 ? where[0] : and(...where);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(activityLog).where(whereExpr);
    const rows = await db
      .select()
      .from(activityLog)
      .where(whereExpr)
      .orderBy(desc(activityLog.createdAt))
      .limit(limit)
      .offset(offset);

    setTotalCount(c, Number(n));
    return c.json(rows);
  },
);

// Mount whoami without requireAdmin — the point is to let any authenticated
// user discover admin status via the 200/403 split. requireAuth still runs.
const whoamiRoutes = new Hono<{ Variables: AuthVars }>();
whoamiRoutes.use('*', requireAuth(), assertEmailVerified());
whoamiRoutes.get('/whoami', async (c) => {
  const userId = c.get('userId');
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) {
    throw new HTTPException(401, { message: 'user not found', cause: { code: 'UNAUTHENTICATED' } });
  }
  // Mirror the allow-list check from requireAdmin, but answer Yes/No
  // instead of throwing 403. This lets the /admin layout branch on the
  // result without UI flicker.
  // biome-ignore lint/style/noProcessEnv: env parsing is centralised; this
  // single call is hot-path-safe.
  const { env } = await import('../config/env.js');
  const allowed = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = allowed.includes(row.email.toLowerCase());
  return c.json({ isAdmin, email: row.email });
});

adminRoutes.route('/', whoamiRoutes);
adminRoutes.route('/', adminProtected);
