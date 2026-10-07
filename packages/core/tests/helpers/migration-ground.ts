import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { journal, migrateThrough } from './migrations.js';

function adminUrl(): string {
  const url = process.env.TEST_PG_ADMIN_URL;
  if (!url) throw new Error('TEST_PG_ADMIN_URL is unset: run under the integration config');
  return url;
}

function urlOf(database: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function asAdmin(statement: string): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export interface MigrationDb {
  /** A client on a database standing at the migration before the one under test. */
  sql: postgres.Sql;
  /** Apply the migration under test, as the deploy would. */
  migrate(): Promise<void>;
  drop(): Promise<void>;
}

export interface MigrationGround {
  /** A fresh copy of the ground, so each case seeds the rows the deploy will find. */
  fresh(): Promise<MigrationDb>;
  drop(): Promise<void>;
}

/** A database migrated through the migration shipped just before `tag`, to clone per case. */
export async function groundBefore(tag: string): Promise<MigrationGround> {
  const entries = journal().entries;
  const at = entries.findIndex((e) => e.tag === tag);
  const prior = entries[at - 1];
  if (at < 1 || !prior) throw new Error(`${tag} has no migration before it in the journal`);

  const ground = `ground_${randomBytes(5).toString('hex')}`;
  await asAdmin(`CREATE DATABASE "${ground}"`);
  await migrateThrough(urlOf(ground), prior.tag);

  return {
    async fresh() {
      const name = `mig_${randomBytes(5).toString('hex')}`;
      await asAdmin(`CREATE DATABASE "${name}" TEMPLATE "${ground}"`);
      const client = postgres(urlOf(name), { max: 2, onnotice: () => {} });
      return {
        sql: client,
        migrate: () => migrateThrough(urlOf(name), tag),
        async drop() {
          await client.end({ timeout: 5 });
          await asAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        },
      };
    },
    drop: () => asAdmin(`DROP DATABASE IF EXISTS "${ground}" WITH (FORCE)`),
  };
}
