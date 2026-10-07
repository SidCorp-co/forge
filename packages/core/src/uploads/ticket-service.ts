import type { AttachmentRefusalCode } from '@forge/contracts/attachments';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uploadTickets } from '../db/schema.js';
import {
  allowedSetForTarget,
  NAME_MAX_BYTES,
  nameExceedsByteBudget,
  safeName,
} from '../lib/attachment-mime.js';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';

/** How long a minted upload ticket stays valid. Short by design (replay window). */
export const UPLOAD_TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * How long after its PUT consumed it a ticket still answers a replay of that PUT with the stored
 * attachment. A reloaded browser retrying a lost response is inside it; past it the ticket is
 * "already used" like any other, and a caller wanting the file again mints under a new operation id.
 */
export const UPLOAD_REPLAY_WINDOW_MS = 60 * 60 * 1000;

/** A conversation is the one target a ticket is minted for (`assistant/conversation-attachment-routes.ts`). */
type UploadTargetType = 'conversation';

const refuse = refuser<AttachmentRefusalCode>('ATTACHMENT_REFUSED');

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
  operationId: string | null;
  result: unknown;
  createdAt: Date;
}

interface CreateUploadTicketInput {
  targetType: UploadTargetType;
  targetId: string;
  uploaderId: string;
  uploaderDeviceId: string | null;
  name: string;
  mime: string;
  /** Minted by the caller once per file it means to store; a second mint of it returns the first ticket. */
  operationId: string;
}

/**
 * Mint a single-use capability ticket.
 *
 * The declared mime is checked against the target's set up front, so a caller
 * naming a type the tracker will never take is refused before it streams
 * anything. It is NOT the last word: no byte exists yet, and the PUT resolves
 * the stored type from the bytes (`lib/attachment-mime.ts`). That is what lets
 * an unknown extension mint as `text/plain` and be judged when it arrives.
 */
export async function createUploadTicket(
  input: CreateUploadTicketInput,
): Promise<{ id: string; expiresAt: Date; maxBytes: number; replay: boolean }> {
  const allowed = allowedSetForTarget(input.targetType);
  if (!allowed.mimes.includes(input.mime)) {
    throw refuse(
      'MIME_NOT_ALLOWED',
      `mime not allowed: ${input.mime}; this ${input.targetType} takes ${allowed.mimes.join(', ')}`,
      '/mime',
    );
  }
  if (nameExceedsByteBudget(safeName(input.name))) {
    throw refuse(
      'INVALID_NAME',
      `name is longer than ${NAME_MAX_BYTES} bytes of UTF-8 — rename the file and mint again`,
      '/name',
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
      operationId: input.operationId,
    })
    .onConflictDoNothing({
      target: [
        uploadTickets.uploaderId,
        uploadTickets.targetType,
        uploadTickets.targetId,
        uploadTickets.operationId,
      ],
      where: sql`operation_id IS NOT NULL`,
    })
    .returning({ id: uploadTickets.id });
  if (row) return { id: row.id, expiresAt, maxBytes, replay: false };
  return replayedMint(input);
}

/**
 * The operation id was minted before: the same file gets its ticket back, a different file under
 * the same id is refused by name. A ticket nobody used that has since expired is re-opened for a
 * fresh window, so a retry after a long pause is not told the capability it was handed is dead.
 */
async function replayedMint(
  input: CreateUploadTicketInput,
): Promise<{ id: string; expiresAt: Date; maxBytes: number; replay: true }> {
  const [held] = await db
    .select()
    .from(uploadTickets)
    .where(
      and(
        eq(uploadTickets.uploaderId, input.uploaderId),
        eq(uploadTickets.targetType, input.targetType),
        eq(uploadTickets.targetId, input.targetId),
        eq(uploadTickets.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (!held) throw new Error(`upload ticket for operation ${input.operationId} vanished`);
  if (held.name !== input.name || held.mime !== input.mime) {
    throw refuse(
      'UPLOAD_OPERATION_REUSED',
      `operation ${input.operationId} already minted a ticket for ${held.name} (${held.mime}), and this call names ${input.name} (${input.mime}) — mint one operation id per file`,
      '/operationId',
    );
  }
  let expiresAt = held.expiresAt;
  if (held.consumedAt === null && expiresAt.getTime() <= Date.now()) {
    expiresAt = new Date(Date.now() + UPLOAD_TICKET_TTL_MS);
    await db.update(uploadTickets).set({ expiresAt }).where(eq(uploadTickets.id, held.id));
  }
  return { id: held.id, expiresAt, maxBytes: held.maxBytes, replay: true };
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

/** Record what the PUT that consumed a ticket answered, for the replay of that PUT. */
export async function recordUploadResult(id: string, result: unknown): Promise<void> {
  await db
    .update(uploadTickets)
    .set({ result: result as never })
    .where(eq(uploadTickets.id, id));
}

/**
 * What a PUT to a ticket that is no longer claimable should answer: the stored result of the PUT
 * that consumed it, within the replay window. A ticket whose first PUT has not finished, or
 * finished without recording an answer, is refused by name rather than answered with a guess;
 * anything else is "not found, expired or used" (null).
 */
export async function replayOfUsedTicket(id: string): Promise<{ result: unknown } | null> {
  const [row] = await db.select().from(uploadTickets).where(eq(uploadTickets.id, id)).limit(1);
  if (!row?.consumedAt || row.operationId === null) return null;
  if (Date.now() - row.consumedAt.getTime() > UPLOAD_REPLAY_WINDOW_MS) return null;
  if (row.result !== null && row.result !== undefined) return { result: row.result };
  const sinceMs = Date.now() - row.consumedAt.getTime();
  if (sinceMs <= UPLOAD_TICKET_TTL_MS) {
    throw refuse(
      'UPLOAD_IN_PROGRESS',
      `the PUT that took upload ${id} has not finished; wait for its answer or retry in a moment`,
    );
  }
  throw refuse(
    'UPLOAD_OUTCOME_UNKNOWN',
    `the PUT that took upload ${id} never recorded what it stored, so core cannot say whether the file landed — check the room, then mint again under a new operation id`,
  );
}
