import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { startPostgres, stopPostgres } from './postgres-container.js';

export const TEMPLATE_DB = 'forge_template';
export const MIGRATIONS_FOLDER = new URL('../../drizzle/migrations', import.meta.url).pathname;

let owned: string | null = null;

function removeOnExit(): void {
  if (owned === null) return;
  const name = owned;
  owned = null;
  try {
    stopPostgres(name);
  } catch {}
}

/** Every drizzle migration, applied the way `src/db/migrate.ts` applies them at boot. */
export async function migrateDatabase(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export async function setup(): Promise<void> {
  const started = await startPostgres();
  owned = started.name;
  process.once('exit', removeOnExit);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      removeOnExit();
      process.exit(130);
    });
  }
  const admin = postgres(started.adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const template = new URL(started.adminUrl);
  template.pathname = `/${TEMPLATE_DB}`;
  const began = Date.now();
  await migrateDatabase(template.toString());
  console.log(
    `[integration] ${started.name} on 127.0.0.1:${started.port}, template migrated in ${Date.now() - began}ms`,
  );
  process.env.TEST_PG_ADMIN_URL = started.adminUrl;
  process.env.TEST_PG_TEMPLATE = TEMPLATE_DB;
}

export async function teardown(): Promise<void> {
  if (owned === null) return;
  const name = owned;
  owned = null;
  stopPostgres(name);
}
