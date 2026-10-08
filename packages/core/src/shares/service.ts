// The one writer of `share_links`: create, revoke and open a share. A share is a frozen, scrubbed
// report document; opening it reads that row and nothing else in the project. It stands only while
// it is unexpired, unrevoked, and its creator still holds the permission that made it, so a creator
// who leaves the project takes their links with them on the next request.

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import type { ActorAgency, ProjectPermission } from '@forge/contracts/permissions';
import type { ReportDocument } from '@forge/contracts/report-templates';
import {
  SHARE_AUDIENCES,
  SHARE_TOKEN_SHAPE,
  type ShareAudience,
  type ShareAudienceOption,
  type ShareCreate,
  type ShareCreated,
  type ShareLinkView,
  type ShareSnapshot,
} from '@forge/contracts/shares';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { shareLinks } from '../db/schema.js';
import { effectiveProjectRole, type ProjectAccess } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { RULES } from '../lib/rate-limits.js';
import { RefusalError } from '../lib/refusal.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { holds, requireHeld } from '../permissions/index.js';
import { forgeLink } from './forge-link.js';
import { refuse, shareSubjectSource } from './ports.js';
import { linkEgress, shareSnapshot } from './snapshot.js';
import { hashShareToken, isShareTokenShaped } from './token.js';

type Row = typeof shareLinks.$inferSelect;

const DAY_MS = 86_400_000;

/** What each audience needs of its creator, at creation and for as long as the share stands. */
const CREATED_WITH: Record<ShareAudience, ProjectPermission> = {
  members: 'shares.write',
  link: 'shares.public',
};

export function shareView(row: Row): ShareLinkView {
  return {
    id: row.id,
    projectId: row.projectId,
    audience: row.audience,
    subjectKind: row.subjectKind,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
  };
}

async function rowOf(projectId: string, shareId: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.id, shareId), eq(shareLinks.projectId, projectId)))
    .limit(1);
  if (!row) {
    throw refuse('SHARE_NOT_FOUND', `share ${shareId} is not one of project ${projectId}'s shares`);
  }
  return row;
}

/**
 * What creating a share for `audience` asks of its creator and project, before any subject is read:
 * `shares.write`, and for a link share `shares.public` and a data policy that lets data leave.
 */
function admitAudience(
  access: ProjectAccess,
  audience: ShareAudience,
  level: SensitiveDataLevel,
  projectId: string,
): void {
  requireHeld(access, 'shares.write', 'creating a share');
  if (audience !== 'link') return;
  requireHeld(access, 'shares.public', 'creating a share open to anyone holding its link');
  linkEgress(level, projectId, null);
}

/**
 * For each audience, whether the caller may create a share for it now: open, or the refusal
 * creating one would answer, by code and core's own sentence. The checks are `createShare`'s own,
 * so a screen offering an audience never guesses which one it may offer.
 */
export async function shareAudienceOptions(
  projectId: string,
  access: ProjectAccess,
): Promise<ShareAudienceOption[]> {
  requireHeld(access, 'project.read');
  const level = await dataPolicyOf(projectId);
  return SHARE_AUDIENCES.map((audience) => {
    try {
      admitAudience(access, audience, level, projectId);
      return { audience, refusal: null };
    } catch (err) {
      if (!(err instanceof RefusalError)) throw err;
      const lead = err.refusals[0];
      if (!lead) throw err;
      return { audience, refusal: { code: lead.code, message: lead.detail } };
    }
  });
}

/**
 * Freeze the subject as the creator reads it now, scrub it, and keep it behind a fresh token. A link
 * share needs `shares.public` and a project whose data policy lets data leave; every share needs
 * `shares.write`. The link is answered once, here.
 */
export async function createShare(args: {
  projectId: string;
  userId: string;
  agency: ActorAgency;
  access: ProjectAccess;
  body: ShareCreate;
}): Promise<ShareCreated> {
  const { projectId, access, body } = args;
  const level = await dataPolicyOf(projectId);
  admitAudience(access, body.audience, level, projectId);
  const document = await shareSubjectSource(body.subjectKind).freeze({
    projectId,
    subjectId: body.subjectId,
    userId: args.userId,
    agency: args.agency,
    access,
  });
  const snapshot: ReportDocument = shareSnapshot({
    document,
    projectId,
    audience: body.audience,
    level,
  });
  const published = await forgeLink.publish({
    projectId,
    audience: body.audience,
    subjectKind: body.subjectKind,
    expiresAt: new Date(Date.now() + body.expiresInDays * DAY_MS),
    document: snapshot,
    createdBy: args.userId,
  });
  return { share: shareView(await rowOf(projectId, published.id)), url: published.url };
}

export async function listShares(projectId: string): Promise<ShareLinkView[]> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.projectId, projectId))
    .orderBy(desc(shareLinks.createdAt))
    .limit(200);
  return rows.map(shareView);
}

/** Revoke a share now: its creator or a project admin, once. The next open answers not available. */
export async function revokeShare(args: {
  projectId: string;
  shareId: string;
  userId: string;
  access: ProjectAccess;
}): Promise<ShareLinkView> {
  requireHeld(args.access, 'project.read', 'revoking a share');
  const row = await rowOf(args.projectId, args.shareId);
  if (row.createdBy !== args.userId && !holds(args.access, 'project.admin')) {
    throw refuse(
      'SHARE_REVOKE_FORBIDDEN',
      `share ${row.id} is revoked only by the person who created it or a project admin (project.admin on ${row.projectId}); the caller is neither`,
    );
  }
  const alreadyRevoked = () =>
    refuse(
      'SHARE_ALREADY_REVOKED',
      `share ${row.id} was already revoked; a revocation is never undone`,
    );
  if (row.revokedAt) throw alreadyRevoked();
  const [revoked] = await db
    .update(shareLinks)
    .set({ revokedAt: sql`now()`, revokedBy: args.userId })
    .where(and(eq(shareLinks.id, row.id), isNull(shareLinks.revokedAt)))
    .returning();
  if (!revoked) throw alreadyRevoked();
  return shareView(revoked);
}

const NOT_AVAILABLE =
  'this share link is not available: it does not exist, has expired or was revoked, or the person who created it can no longer share from the project';

/** Who opens a share: a signed-in person, or nobody known. */
export type ShareOpener = { userId: string } | null;

/**
 * Open a share by its token: the frozen snapshot and nothing else. An unknown, tampered, expired or
 * revoked token, and one whose creator no longer holds what created it, all answer the same
 * `SHARE_NOT_AVAILABLE`, so the answer says nothing about which tokens exist.
 */
export async function openShare(token: string, opener: ShareOpener): Promise<ShareSnapshot> {
  if (!isShareTokenShaped(token)) {
    throw refuse('SHARE_TOKEN_MALFORMED', `a share token is ${SHARE_TOKEN_SHAPE}`, '/token');
  }
  const hash = hashShareToken(token);
  const rule = RULES.shareOpenToken;
  const outcome = await consumeRateLimit(
    `share-open:${hash.slice(0, 32)}`,
    rule.max,
    rule.windowMs,
  );
  if (!outcome.allowed) {
    throw new HTTPException(429, {
      message: 'this share link is being opened too often; try again shortly',
      cause: {
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: Math.max(1, Math.ceil(outcome.resetMs / 1000)) },
      },
    });
  }
  const unavailable = () => refuse('SHARE_NOT_AVAILABLE', NOT_AVAILABLE);
  const [row] = await db.select().from(shareLinks).where(eq(shareLinks.tokenHash, hash)).limit(1);
  if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) throw unavailable();
  const creator = await effectiveProjectRole(row.createdBy, row.projectId);
  if (!creator || !holds(creator, CREATED_WITH[row.audience])) throw unavailable();
  if (row.audience === 'members') {
    if (!opener) {
      throw refuse(
        'SHARE_SIGN_IN_REQUIRED',
        "this share is open to the project's members only; sign in to open it",
      );
    }
    const reader = await effectiveProjectRole(opener.userId, row.projectId);
    if (!reader || !holds(reader, 'project.read')) {
      throw refuse(
        'SHARE_AUDIENCE_FORBIDDEN',
        "this share is open to the project's members only, and the signed-in account cannot read the project",
      );
    }
  }
  const [opened] = await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1`, lastViewedAt: sql`now()` })
    .where(
      and(
        eq(shareLinks.id, row.id),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, sql`now()`),
      ),
    )
    .returning({ snapshot: shareLinks.snapshot, expiresAt: shareLinks.expiresAt });
  if (!opened) throw unavailable();
  return {
    audience: row.audience,
    expiresAt: opened.expiresAt.toISOString(),
    document: opened.snapshot as ReportDocument,
  };
}
