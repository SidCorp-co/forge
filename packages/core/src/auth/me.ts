import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { oauthAccounts, userPreferences, users } from '../db/schema.js';
import { assertOrgAccess } from '../lib/authz.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';

export const meRoutes = new Hono<{ Variables: AuthVars }>();

// cm:guard BOTH lines, and neither covers the other: Hono's `*` does not match the bare `/me` this router's profile GET and PATCH are served on, so dropping the first line answers every caller on the profile before any auth middleware runs. Covering the prefix rather than each handler is safe only because every handler here is user-scoped and reads `c.get('userId')`; a route added below that takes an id from the caller is not, and belongs behind its own gate.
meRoutes.use('/me', requireAuth());
meRoutes.use('/me/*', requireAuth());

meRoutes.get('/me', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      lastFreshAuthAt: users.lastFreshAuthAt,
      // Selected only to derive `hasPassword` — the hash itself is never
      // serialized below.
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }

  const oauthRows = await db
    .select({ provider: oauthAccounts.provider })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.userId, userId));
  const oauthProviders = Array.from(new Set(oauthRows.map((r) => r.provider)));

  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    lastFreshAuthAt: row.lastFreshAuthAt,
    hasPassword: row.passwordHash !== null,
    oauthProviders,
  });
});

/**
 * The name a person is shown as, in their own words (ISS-1003).
 *
 * Trimmed and bounded, and otherwise anything they type — accents included.
 * `null` clears it, which puts them back to being rendered by address.
 */
// cm:guard a person sets their OWN and only their own: the handler reads `c.get('userId')` and takes no id from the caller. An org admin editing somebody else's name would be a second writer of the same column with a different rule behind it, and the one org admins DO edit is an agent's, through `/api/orgs/:orgId/agents/:agentUserId` where the admin gate lives.
const profileSchema = z
  .object({ displayName: z.string().trim().min(1).max(200).nullable() })
  .strict();

meRoutes.patch(
  '/me',
  zValidator('json', profileSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const [row] = await db
      .update(users)
      .set({ displayName: c.req.valid('json').displayName })
      .where(eq(users.id, c.get('userId')))
      .returning({ id: users.id, email: users.email, displayName: users.displayName });
    if (!row) {
      throw new HTTPException(401, {
        message: 'user not found',
        cause: { code: 'UNAUTHENTICATED' },
      });
    }
    return c.json(row);
  },
);

// `system` follows the OS preference at render time; the value just gets
// echoed back to the client. Languages enumerated narrowly so a typo on the
// client doesn't silently break the i18n loader.
const themes = ['system', 'light', 'dark'] as const;
const languages = ['en', 'vi'] as const;

const preferencesSchema = z
  .object({
    theme: z.enum(themes).optional(),
    language: z.enum(languages).optional(),
    notifyOnMention: z.boolean().optional(),
    // Identity of the newest "What's New" entry the user has seen (changelog
    // version or `unreleased:<hash>`). Opaque to the server (ISS-384).
    lastSeenWhatsNew: z.string().max(200).optional(),
    // The org the user is currently "working in" (ISS-469). `null` clears it
    // back to "no explicit choice" (the client resolves that to the personal
    // org). A non-null value is membership-checked below before it is stored.
    activeOrgId: z.string().uuid().nullable().optional(),
  })
  .strict();

const DEFAULT_PREFS = {
  theme: 'system' as const,
  language: 'en' as const,
  notifyOnMention: true,
  lastSeenWhatsNew: null as string | null,
  activeOrgId: null as string | null,
};

meRoutes.get('/me/preferences', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      theme: userPreferences.theme,
      language: userPreferences.language,
      notifyOnMention: userPreferences.notifyOnMention,
      lastSeenWhatsNew: userPreferences.lastSeenWhatsNew,
      activeOrgId: userPreferences.activeOrgId,
      updatedAt: userPreferences.updatedAt,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row) {
    return c.json({ ...DEFAULT_PREFS, updatedAt: null });
  }
  return c.json(row);
});

meRoutes.patch(
  '/me/preferences',
  zValidator('json', preferencesSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const userId = c.get('userId');
    const patch = c.req.valid('json');
    if (Object.keys(patch).length === 0) {
      throw new HTTPException(400, {
        message: 'no fields to update',
        cause: { code: 'BAD_REQUEST' },
      });
    }

    // cm:guard the membership check is what stops a preference being a back door into an org: `activeOrgId` is stored and then read by every screen that resolves "the org I am working in", so an unchecked write would let anyone name an org they hold no role on and have the product address them as a member of it. `assertOrgAccess` answers 404 for an org that is not there and 403 for one the caller does not reach; `null` clears the pointer and names no org to check (ISS-469 AC7).
    if (patch.activeOrgId != null) {
      await assertOrgAccess(patch.activeOrgId, userId, 'member');
    }

    // Insert a row if missing, otherwise patch only the keys the caller sent.
    // postgres `INSERT ... ON CONFLICT DO UPDATE` keeps this single round-trip.
    const [row] = await db
      .insert(userPreferences)
      .values({
        userId,
        theme: patch.theme ?? DEFAULT_PREFS.theme,
        language: patch.language ?? DEFAULT_PREFS.language,
        notifyOnMention: patch.notifyOnMention ?? DEFAULT_PREFS.notifyOnMention,
        lastSeenWhatsNew: patch.lastSeenWhatsNew ?? DEFAULT_PREFS.lastSeenWhatsNew,
        activeOrgId: patch.activeOrgId ?? DEFAULT_PREFS.activeOrgId,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          ...(patch.language !== undefined ? { language: patch.language } : {}),
          ...(patch.notifyOnMention !== undefined
            ? { notifyOnMention: patch.notifyOnMention }
            : {}),
          ...(patch.lastSeenWhatsNew !== undefined
            ? { lastSeenWhatsNew: patch.lastSeenWhatsNew }
            : {}),
          ...(patch.activeOrgId !== undefined ? { activeOrgId: patch.activeOrgId } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({
        theme: userPreferences.theme,
        language: userPreferences.language,
        notifyOnMention: userPreferences.notifyOnMention,
        lastSeenWhatsNew: userPreferences.lastSeenWhatsNew,
        activeOrgId: userPreferences.activeOrgId,
        updatedAt: userPreferences.updatedAt,
      });

    return c.json(row);
  },
);
