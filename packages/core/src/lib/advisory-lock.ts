import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Db } from '../db/client.js';

/** A transaction, or the pool for a caller already inside one; only `execute` is used. */
type LockExecutor = Pick<Db, 'execute'>;

/**
 * Every advisory-lock namespace and its int4 id, picked once. A lock is the two-key form
 * `(namespace, hashtext(key))`, so two namespaces never share a keyspace whatever their keys hash
 * to. An id is never renumbered or reused: while a deploy overlaps, the old process and the new
 * one must take the same lock for the same thing. `releaseVersion` keeps the id it had before
 * this registry existed.
 */
export const LOCK_NAMESPACES = {
  agentSession: 1,
  job: 2,
  issueDependencies: 3,
  questionnaire: 4,
  commentTarget: 6,
  commentOnce: 7,
  conversationHandle: 8,
  conversationHeartbeat: 9,
  patName: 10,
  agentFence: 11,
  masterSession: 12,
  runEvidence: 13,
  runSession: 14,
  ecosystem: 15,
  feedback: 16,
  attachmentName: 17,
  masterPass: 18,
  mockups: 19,
  onboarding: 20,
  userPreferences: 21,
  projectConfigBinding: 22,
  projectConfig: 23,
  masterCharter: 24,
  requirements: 25,
  suggestions: 26,
  workflows: 27,
  rocketchatConnection: 28,
  releaseVersion: 1120,
} as const;

export type LockNamespace = keyof typeof LOCK_NAMESPACES;

/** Wait for the transaction-scoped lock on `key` in `namespace`; it releases at commit or rollback. */
export async function lockXact(tx: LockExecutor, namespace: LockNamespace, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACES[namespace]}::int4, hashtext(${key}))`,
  );
}

/** Take the transaction-scoped lock if it is free; answers whether this transaction now holds it. */
export async function tryLockXact(
  tx: LockExecutor,
  namespace: LockNamespace,
  key: string,
): Promise<boolean> {
  const rows = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACES[namespace]}::int4, hashtext(${key})) AS locked`,
  );
  return rows[0]?.locked === true;
}

/**
 * The session-scoped form, for a dedicated `pg` client that holds a lock for as long as it stays
 * connected; it releases on `unlockSession` or when the connection ends.
 */
export async function tryLockSession(
  client: pg.ClientBase,
  namespace: LockNamespace,
  key: string,
): Promise<boolean> {
  const res = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1::int4, hashtext($2)) as locked',
    [LOCK_NAMESPACES[namespace], key],
  );
  return res.rows[0]?.locked === true;
}

export async function unlockSession(
  client: pg.ClientBase,
  namespace: LockNamespace,
  key: string,
): Promise<void> {
  await client.query('select pg_advisory_unlock($1::int4, hashtext($2))', [
    LOCK_NAMESPACES[namespace],
    key,
  ]);
}
