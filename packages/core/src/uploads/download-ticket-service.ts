// Read-side capability tickets. `upload_tickets` solved "write bytes without a
// session"; this solves the mirror problem, which had no answer at all: an agent
// could SEE an attachment (vision) but could not obtain its bytes — the
// authenticated download route 401s for a device token, a PAT, and no-auth
// alike, and a third-party service told to fetch that URL has no Forge session
// either. Agents worked around it by recreating owner-supplied images from
// scratch with Playwright, which is not a workaround so much as a data loss.
//
// The unguessable id IS the credential (same reasoning as the upload ticket),
// so the route needs no Authorization header and any fetcher can use it.

import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { downloadTickets } from '../db/schema.js';

/** Short by design — the TTL is the whole containment for a bearer-in-the-URL. */
export const DOWNLOAD_TICKET_TTL_MS = 10 * 60 * 1000;

export type DownloadTargetType = 'issue' | 'comment' | 'session';

export interface CreateDownloadTicketInput {
  targetType: DownloadTargetType;
  attachmentId: string;
  projectId: string;
  issuedToUserId: string | null;
  issuedToDeviceId: string | null;
}

export async function createDownloadTicket(
  input: CreateDownloadTicketInput,
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + DOWNLOAD_TICKET_TTL_MS);
  const [row] = await db
    .insert(downloadTickets)
    .values({
      targetType: input.targetType,
      attachmentId: input.attachmentId,
      projectId: input.projectId,
      issuedToUserId: input.issuedToUserId,
      issuedToDeviceId: input.issuedToDeviceId,
      expiresAt,
    })
    .returning({ id: downloadTickets.id });
  if (!row) throw new Error('failed to create download ticket');
  return { id: row.id, expiresAt };
}

export interface ResolvedDownloadTicket {
  targetType: DownloadTargetType;
  attachmentId: string;
  projectId: string;
}

/**
 * Resolve a ticket for reading. Returns null when unknown or expired.
 * Deliberately NOT single-use — see the `expiresAt` guard on the table.
 */
export async function resolveDownloadTicket(
  ticketId: string,
): Promise<ResolvedDownloadTicket | null> {
  const [row] = await db
    .update(downloadTickets)
    .set({
      fetchCount: sql`${downloadTickets.fetchCount} + 1`,
      lastFetchedAt: sql`now()`,
    })
    .where(and(eq(downloadTickets.id, ticketId), gt(downloadTickets.expiresAt, sql`now()`)))
    .returning({
      targetType: downloadTickets.targetType,
      attachmentId: downloadTickets.attachmentId,
      projectId: downloadTickets.projectId,
    });
  if (!row) return null;
  return {
    targetType: row.targetType as DownloadTargetType,
    attachmentId: row.attachmentId,
    projectId: row.projectId,
  };
}

/** Delete tickets whose TTL has passed. Called by the same sweep as uploads. */
export async function purgeExpiredDownloadTickets(): Promise<number> {
  const rows = await db
    .delete(downloadTickets)
    .where(sql`${downloadTickets.expiresAt} < now()`)
    .returning({ id: downloadTickets.id });
  return rows.length;
}
