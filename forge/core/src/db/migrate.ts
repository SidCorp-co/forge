import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('[migrate] DATABASE_URL not set');
  process.exit(1);
}

const migrationsFolder = new URL('../../drizzle/migrations', import.meta.url).pathname;
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  console.log('[migrate] applying migrations from', migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log('[migrate] done');
} catch (err) {
  console.error('[migrate] failed', err);
  process.exit(1);
} finally {
  await sql.end();
}
