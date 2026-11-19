// The asks a room agent made through the one secret door (ISS-1348), and their one-time write URLs.
// A write URL's token is kept as its SHA-256 alone; it is claimed in one statement, so two PUTs never
// both win, and released where the write it carried was refused, so a person can fix the file and try
// again before it expires.

import { createHash, randomBytes } from 'node:crypto';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { SecretSlotKind } from '@forge/contracts/support';
import { and, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportSecretAsks } from '../db/schema-support-secrets.js';
import { emitEvent } from '../outbox/index.js';

export type AskRow = typeof supportSecretAsks.$inferSelect;

/** How long a write URL stays good: long enough to find the file, short enough to be spent. */
export const SECRET_WRITE_TTL_MINUTES = 15;

/** How far back an unfilled ask still hears that its slot was filled. */
const ASK_OPEN_MS = 7 * 24 * 60 * 60_000;

export const tokenHashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export interface NewAsk {
  projectId: string;
  roomId: string;
  thread: string;
  kind: SecretSlotKind;
  slot: Record<string, string | null>;
  slotKey: string;
  link: string;
}

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

/** Every unfilled ask for `slotKey`, marked filled by `fingerprint`; each ask is told once. */
export async function fillAsks(
  slotKey: string,
  fill: { fingerprint: string; via: 'page' | 'presigned'; at: Date },
): Promise<AskRow[]> {
  return db
    .update(supportSecretAsks)
    .set({ filledAt: fill.at, filledFingerprint: fill.fingerprint, filledVia: fill.via })
    .where(
      and(
        eq(supportSecretAsks.slotKey, slotKey),
        isNull(supportSecretAsks.filledAt),
        gte(supportSecretAsks.createdAt, new Date(Date.now() - ASK_OPEN_MS)),
      ),
    )
    .returning();
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
): Promise<void> {
  await emitEvent(db, 'secret.slotFilled', filled);
}
