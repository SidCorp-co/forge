import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { ALLOWED_MIMES as COMMENT_ALLOWED_MIMES } from '../comments/attachment-service.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { uploadTickets } from '../db/schema.js';
import { ALLOWED_MIMES as ISSUE_ALLOWED_MIMES } from '../issues/attachment-service.js';

/** How long a minted upload ticket stays valid. Short by design (replay window). */
export const UPLOAD_TICKET_TTL_MS = 5 * 60 * 1000;

export type UploadTargetType = 'issue' | 'comment';

export type UploadTicketErrorCode = 'MIME_NOT_ALLOWED';

export class UploadTicketError extends Error {
  readonly code: UploadTicketErrorCode;
  constructor(code: UploadTicketErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'UploadTicketError';
  }
}

export interface UploadTicket {
  id: string;
  targetType: UploadTargetType;
  targetId: string;
  uploaderId: string;
  uploaderDeviceId: string | null;
  name: string;
  mime: string;
  maxBytes: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface CreateUploadTicketInput {
  targetType: UploadTargetType;
  targetId: string;
  uploaderId: string;
  uploaderDeviceId: string | null;
  name: string;
  mime: string;
}

function allowedMimesFor(targetType: UploadTargetType): ReadonlySet<string> {
  return targetType === 'issue' ? ISSUE_ALLOWED_MIMES : COMMENT_ALLOWED_MIMES;
}

/**
 * Mint a single-use capability ticket. Validates the declared mime up front so
 * the holder gets a fast, clear failure instead of discovering it only after
 * streaming the bytes. The mime stored here is authoritative at consume time.
 */
export async function createUploadTicket(
  input: CreateUploadTicketInput,
): Promise<{ id: string; expiresAt: Date; maxBytes: number }> {
  if (!allowedMimesFor(input.targetType).has(input.mime)) {
    throw new UploadTicketError('MIME_NOT_ALLOWED', `mime not allowed: ${input.mime}`);
  }
  const expiresAt = new Date(Date.now() + UPLOAD_TICKET_TTL_MS);
  const maxBytes = env.UPLOADS_MAX_BYTES;
  const [row] = await db
    .insert(uploadTickets)
    .values({
      targetType: input.targetType,
      targetId: input.targetId,
      uploaderId: input.uploaderId,
      uploaderDeviceId: input.uploaderDeviceId,
      name: input.name,
      mime: input.mime,
      maxBytes,
      expiresAt,
    })
    .returning({ id: uploadTickets.id });
  if (!row) throw new Error('failed to create upload ticket');
  return { id: row.id, expiresAt, maxBytes };
}

/**
 * Atomically claim a ticket for consumption. Returns the ticket only if it was
 * still pending (not consumed, not expired) — the single UPDATE doubles as the
 * concurrency guard, so two parallel PUTs cannot both win. Callers MUST call
 * {@link releaseUploadTicket} if the subsequent persist fails, so a transient
 * error doesn't burn the ticket.
 */
export async function claimUploadTicket(id: string): Promise<UploadTicket | null> {
  const [row] = await db
    .update(uploadTickets)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(uploadTickets.id, id),
        isNull(uploadTickets.consumedAt),
        gt(uploadTickets.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return (row as UploadTicket | undefined) ?? null;
}

/** Re-open a claimed ticket so the holder can retry after a transient failure. */
export async function releaseUploadTicket(id: string): Promise<void> {
  await db.update(uploadTickets).set({ consumedAt: null }).where(eq(uploadTickets.id, id));
}
