// The asks a room agent made through the one secret door (ISS-1348), and their one-time write URLs.
// A write URL's token is kept as its SHA-256 alone; it is claimed in one statement, so two PUTs never
// both win, and released where the write it carried was refused, so a person can fix the file and try
// again before it expires.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { SecretShape } from '@forge/contracts/secret-slots';
import type { SecretSlotKind } from '@forge/contracts/support';
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { supportSecretAsks } from '../db/schema-support-secrets.js';
import { emitEvent } from '../outbox/index.js';

export type AskRow = typeof supportSecretAsks.$inferSelect;

/** How long a write URL stays good: long enough to find the file, short enough to be spent. */
export const SECRET_WRITE_TTL_MINUTES = 15;

/** How far back an unfilled ask still hears that its slot was filled. */
const ASK_OPEN_MS = 7 * 24 * 60 * 60_000;

export const tokenHashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export interface NewAsk {
  /** Chosen before the insert, so the link can name the request it lands on. */
  id: string;
  projectId: string;
  roomId: string;
  thread: string;
  kind: SecretSlotKind;
  slot: Record<string, string | null>;
  slotKey: string;
  link: string;
  why: string;
  shape: SecretShape | null;
  example: string | null;
  askedFor: string | null;
}

/** A new ask of the same slot, for the same thread and reason: a fresh write URL on a request already made. */
export const againOf = (ask: AskRow): NewAsk => ({
  id: randomUUID(),
  projectId: ask.projectId,
  roomId: ask.roomId,
  thread: ask.thread,
  kind: ask.kind,
  slot: ask.slot,
  slotKey: ask.slotKey,
  link: ask.link,
  why: ask.why,
  shape: ask.shape,
  example: ask.example,
  askedFor: ask.askedFor,
});

/** The ask recorded, with a one-time write token where `presign`; the token is answered once, here. */
export async function recordAsk(
  ask: NewAsk,
  presign: boolean,
): Promise<{ row: AskRow; token: string | null }> {
  const token = presign ? randomBytes(32).toString('base64url') : null;
  const [row] = await db
    .insert(supportSecretAsks)
    .values({
      ...ask,
      writeHash: token ? tokenHashOf(token) : null,
      writeExpiresAt: token ? new Date(Date.now() + SECRET_WRITE_TTL_MINUTES * 60_000) : null,
    })
    .returning();
  if (!row) throw new Error('support: the secret ask insert returned no row');
  return { row, token };
}

/** The ask a write token names, claimed for its one use; null where it is unknown, spent or expired. */
export async function claimWrite(token: string, from: string): Promise<AskRow | null> {
  const [row] = await db
    .update(supportSecretAsks)
    .set({ writeUsedAt: sql`now()`, writeUsedFrom: from })
    .where(
      and(
        eq(supportSecretAsks.writeHash, tokenHashOf(token)),
        isNull(supportSecretAsks.writeUsedAt),
        gt(supportSecretAsks.writeExpiresAt, sql`now()`),
      ),
    )
    .returning();
  return row ?? null;
}

/** A claim given back: the write it carried was refused, so nothing was set and the URL still holds. */
export async function releaseWrite(id: string): Promise<void> {
  await db
    .update(supportSecretAsks)
    .set({ writeUsedAt: null, writeUsedFrom: null })
    .where(eq(supportSecretAsks.id, id));
}

/** What a write token names, whatever its state: for the refusal of a spent or expired one. */
export async function askOfToken(token: string): Promise<AskRow | null> {
  const [row] = await db
    .select()
    .from(supportSecretAsks)
    .where(eq(supportSecretAsks.writeHash, tokenHashOf(token)))
    .limit(1);
  return row ?? null;
}

/** The asks of `slotKey` still open to hear that it was filled. */
export async function openAsksOfSlot(slotKey: string): Promise<AskRow[]> {
  return db
    .select()
    .from(supportSecretAsks)
    .where(
      and(
        eq(supportSecretAsks.slotKey, slotKey),
        isNull(supportSecretAsks.filledAt),
        gte(supportSecretAsks.createdAt, new Date(Date.now() - ASK_OPEN_MS)),
      ),
    )
    .orderBy(asc(supportSecretAsks.createdAt));
}

/**
 * The asks `ids` marked filled by `fingerprint`, in `tx` with the note that tells their thread: those
 * still unfilled, so a pass that fills one first leaves this one nothing to tell again.
 */
export async function fillAsks(
  tx: Tx,
  ids: readonly string[],
  fill: { fingerprint: string; via: 'page' | 'presigned'; by: string | null; at: Date },
): Promise<AskRow[]> {
  if (ids.length === 0) return [];
  return tx
    .update(supportSecretAsks)
    .set({
      filledAt: fill.at,
      filledFingerprint: fill.fingerprint,
      filledVia: fill.via,
      filledBy: fill.by,
    })
    .where(and(inArray(supportSecretAsks.id, [...ids]), isNull(supportSecretAsks.filledAt)))
    .returning();
}

/** The asks made of a project in the last week, newest first: its Secrets page's requests. */
export async function asksOfProject(projectId: string): Promise<AskRow[]> {
  return db
    .select()
    .from(supportSecretAsks)
    .where(
      and(
        eq(supportSecretAsks.projectId, projectId),
        gte(supportSecretAsks.createdAt, new Date(Date.now() - ASK_OPEN_MS)),
      ),
    )
    .orderBy(desc(supportSecretAsks.createdAt));
}

/** One ask of a project, by its id. */
export async function askOf(projectId: string, id: string): Promise<AskRow | null> {
  const [row] = await db
    .select()
    .from(supportSecretAsks)
    .where(and(eq(supportSecretAsks.projectId, projectId), eq(supportSecretAsks.id, id)))
    .limit(1);
  return row ?? null;
}

/** The newest unfilled ask in a thread of a room, for a secret pasted there instead (ISS-1348 c4). */
export async function openAskIn(roomId: string, thread: string): Promise<AskRow | null> {
  const [row] = await db
    .select()
    .from(supportSecretAsks)
    .where(
      and(
        eq(supportSecretAsks.roomId, roomId),
        eq(supportSecretAsks.thread, thread),
        isNull(supportSecretAsks.filledAt),
        gte(supportSecretAsks.createdAt, new Date(Date.now() - ASK_OPEN_MS)),
      ),
    )
    .orderBy(desc(supportSecretAsks.createdAt))
    .limit(1);
  return row ?? null;
}

/** A slot's fill fact a write built and did not emit itself (an integration's credential), told to its asks. */
export async function emitSlotFilled(
  filled: OutboxEventPayload<'secret.slotFilled'>,
  tx: Tx = db,
): Promise<void> {
  await emitEvent(tx, 'secret.slotFilled', filled);
}
