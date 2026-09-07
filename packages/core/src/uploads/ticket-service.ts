import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { ALLOWED_MIMES as SESSION_ALLOWED_MIMES } from '../agent-sessions/attachment-service.js';
import {
  ALLOWED_MIMES as COMMENT_ALLOWED_MIMES,
  findCommentAttachmentByName,
} from '../comments/attachment-service.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { uploadTickets } from '../db/schema.js';
import {
  ALLOWED_MIMES as ISSUE_ALLOWED_MIMES,
  findIssueAttachmentByName,
  safeName,
} from '../issues/attachment-service.js';
import type { ExistingAttachmentRef } from '../lib/attachment-refs.js';

/** How long a minted upload ticket stays valid. Short by design (replay window). */
export const UPLOAD_TICKET_TTL_MS = 5 * 60 * 1000;

export type UploadTargetType = 'issue' | 'comment' | 'session';

export type UploadTicketErrorCode = 'MIME_NOT_ALLOWED' | 'ATTACHMENT_NAME_TAKEN';

export class UploadTicketError extends Error {
  readonly code: UploadTicketErrorCode;
  readonly details: unknown;
  constructor(code: UploadTicketErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
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
  if (targetType === 'issue') return ISSUE_ALLOWED_MIMES;
  if (targetType === 'session') return SESSION_ALLOWED_MIMES;
  return COMMENT_ALLOWED_MIMES;
}

/**
 * The document already holding this name on the target, or null.
 *
 * Sessions are absent by design and not by omission: no record cites a session
 * attachment by name, so uniqueness there would refuse uploads for nothing.
 */
async function takenNameOn(
  targetType: UploadTargetType,
  targetId: string,
  name: string,
): Promise<ExistingAttachmentRef | null> {
  if (targetType === 'issue') return findIssueAttachmentByName(targetId, safeName(name));
  if (targetType === 'comment') return findCommentAttachmentByName(targetId, safeName(name));
  return null;
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
  // cm:edge protocol -> packages/core/src/issues/attachment-service.ts — advisory only, and the persist-time check is the authority: a name free at mint can be taken before the PUT arrives, so removing the check there would leave the rule unenforced while this one still passed (ISS-963)
  const taken = await takenNameOn(input.targetType, input.targetId, input.name);
  if (taken) {
    throw new UploadTicketError(
      'ATTACHMENT_NAME_TAKEN',
      `an attachment named "${taken.name}" is already on this ${input.targetType} (id ${taken.id}, ${taken.url}) — cite it, delete it, or mint under a different name`,
      { existing: taken },
    );
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
