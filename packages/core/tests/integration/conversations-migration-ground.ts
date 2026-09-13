/**
 * ISS-1001 — the ground both migration suites stand on: a database at the
 * schema `0241_conversations.sql` expects to FIND, which the harness's own
 * database no longer has because it is already migrated.
 *
 * Every migration below 0241 goes into one template once per file; each case
 * clones it. That is the only way to plant the row the migration must refuse —
 * after the forward run there is nothing left to plant into.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));

/** The statement list of 0241, and everything below it, split at the seam drizzle splits. */
function migrationParts(): { below: string[]; conversations: string[] } {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const target = files.find((f) => f.sql.join('\n').includes('_iss1001_handles'));
  if (!target) throw new Error('0241_conversations.sql is not in the migrations folder');
  const below = files
    .filter((f) => f.folderMillis < target.folderMillis)
    .sort((a, b) => a.folderMillis - b.folderMillis)
    .flatMap((f) => f.sql);
  return { below, conversations: target.sql };
}

export const { below, conversations } = migrationParts();

export interface PlantedSession {
  id: string;
  projectId: string;
  userId: string | null;
  userKey: string | null;
  title: string | null;
  source: string;
  messages: unknown;
}

export interface PreMigrationGround {
  fresh(): Promise<{ sql: Sql; drop: () => Promise<void> }>;
  stop(): Promise<void>;
}

/** Build the template, and hand back a cloner for it. */
export async function preMigrationGround(): Promise<PreMigrationGround> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const template = `iss1001_tpl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${template}`;
  const tpl = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await tpl.begin(async (tx) => {
      for (const stmt of below) await tx.unsafe(stmt, []);
    });
  } finally {
    await tpl.end({ timeout: 5 });
  }

  return {
    async fresh() {
      const name = `iss1001_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
      const dbUrl = new URL(adminUrl);
      dbUrl.pathname = `/${name}`;
      const sql = postgres(dbUrl.toString(), { max: 1, onnotice: () => {} });
      return {
        sql,
        drop: async () => {
          await sql.end({ timeout: 5 }).catch(() => {});
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        },
      };
    },
    async stop() {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 });
    },
  };
}

/** Run the forward migration as drizzle runs it: every statement, one transaction. */
export async function runForward(
  sql: Sql,
  statements: string[] = conversations,
  /** Statements run inside the migration's OWN transaction, before it — the only
   *  place a temp relation can be planted where the migration will meet it. */
  prelude: string[] = [],
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of prelude) await tx.unsafe(stmt, []);
    for (const stmt of statements) await tx.unsafe(stmt, []);
  });
}

/** An org, a project and a person — the ground a chat session sits on. */
export async function plantProject(
  sql: Sql,
  slug: string,
): Promise<{ orgId: string; projectId: string; ownerId: string }> {
  const ownerId = randomUUID();
  const orgId = randomUUID();
  const projectId = randomUUID();
  await sql.unsafe(
    `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'human', now())`,
    [ownerId, `owner-${ownerId.slice(0, 8)}@example.com`],
  );
  await sql.unsafe(
    `INSERT INTO organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`,
    [orgId, `org ${slug}`, `org-${orgId.slice(0, 8)}`, ownerId],
  );
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id) VALUES ($1, $2, $3, $4, $5)`,
    [projectId, slug, slug, ownerId, orgId],
  );
  await sql.unsafe(
    `INSERT INTO project_members (user_id, project_id, role) VALUES ($1, $2, 'owner')`,
    [ownerId, projectId],
  );
  return { orgId, projectId, ownerId };
}

export async function plantSession(
  sql: Sql,
  row: Partial<PlantedSession> & { projectId: string },
): Promise<PlantedSession> {
  const planted: PlantedSession = {
    id: row.id ?? randomUUID(),
    projectId: row.projectId,
    userId: row.userId ?? null,
    userKey: row.userKey ?? null,
    title: row.title ?? null,
    source: row.source ?? 'web',
    messages: row.messages ?? [],
  };
  await sql.unsafe(
    `INSERT INTO chat_sessions (id, project_id, user_id, user_key, title, source, messages)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)`,
    [
      planted.id,
      planted.projectId,
      planted.userId,
      planted.userKey,
      planted.title,
      planted.source,
      JSON.stringify(planted.messages),
    ],
  );
  return planted;
}
