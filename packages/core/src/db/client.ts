import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

// ISS-663 — bound how long a connection can sit idle-in-transaction or run a
// single statement, so a hung/leaked db.transaction() callback can't pin a
// stale MVCC snapshot on a pooled connection indefinitely.
const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  connection: {
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.DATABASE_IDLE_IN_TX_TIMEOUT_MS,
  },
});

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
