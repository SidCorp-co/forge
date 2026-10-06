import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { AGENT_NAMING_MIN_RUNNER } from '../../src/runners/device-cap.js';

export async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** Empties every table the migrations made, keeping the schema and drizzle's own journal. */
export async function truncateAll(): Promise<void> {
  const tables = await rows<{ name: string }>(sql`
    SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'drizzle')
  `);
  if (tables.length === 0) return;
  await db.execute(
    sql.raw(`TRUNCATE ${tables.map((t) => t.name).join(', ')} RESTART IDENTITY CASCADE`),
  );
}

export interface TestUser {
  id: string;
  email: string;
}

export async function createTestUser(
  opts: { kind?: 'human' | 'agent'; email?: string; verified?: boolean } = {},
): Promise<TestUser> {
  const user = { id: randomUUID(), email: opts.email ?? `user-${randomUUID()}@test.forge.local` };
  const verifiedAt = opts.verified || opts.kind === 'agent' ? new Date().toISOString() : null;
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, email_verified_at, kind)
    VALUES (${user.id}, ${user.email}, '!test-not-a-real-hash', ${verifiedAt}, ${opts.kind ?? 'human'})
  `);
  return user;
}

export async function seedOrg(ownerId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO organizations (id, slug, name, is_personal, created_by)
    VALUES (${id}, ${`org-${id.slice(0, 8)}`}, ${`Org ${id.slice(0, 8)}`}, false, ${ownerId})
  `);
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role) VALUES (${id}, ${ownerId}, 'owner')
  `);
  return id;
}

export interface TestProject {
  id: string;
  slug: string;
  orgId: string;
}

/** A project in a fresh org its creator owns, at `DEFAULT_POLICY` revision 1 unless `policy` says. */
export async function createTestProject(
  createdBy: string,
  opts: {
    orgId?: string;
    agentConfig?: Record<string, unknown>;
    policy?: Record<string, unknown> | null;
  } = {},
): Promise<TestProject> {
  const id = randomUUID();
  const orgId = opts.orgId ?? (await seedOrg(createdBy));
  const slug = `test-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO projects (id, slug, name, org_id, created_by, agent_config)
    VALUES (${id}, ${slug}, ${`Project ${id.slice(0, 8)}`}, ${orgId}, ${createdBy},
            ${JSON.stringify(opts.agentConfig ?? {})}::jsonb)
  `);
  const policy = opts.policy === undefined ? DEFAULT_POLICY : opts.policy;
  if (policy !== null) {
    await db.execute(sql`
      INSERT INTO project_policies (project_id, revision, document, updated_by)
      VALUES (${id}, 1, ${JSON.stringify(policy)}::jsonb, ${createdBy})
    `);
  }
  return { id, slug, orgId };
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'member',
): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_members (user_id, project_id, role) VALUES (${userId}, ${projectId}, ${role})
  `);
}

export async function createTestDevice(
  ownerId: string,
  opts: { status?: 'online' | 'offline'; agentVersion?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO devices (id, owner_id, name, platform, status, agent_version)
    VALUES (${id}, ${ownerId}, ${`device-${id.slice(0, 8)}`}, 'linux', ${opts.status ?? 'online'},
            ${opts.agentVersion ?? AGENT_NAMING_MIN_RUNNER})
  `);
  return id;
}

/** Binds `deviceId` to the project as a runner, which a box must be before it opens a run there. */
export async function bindTestRunner(
  projectId: string,
  deviceId: string,
  opts: { status?: 'online' | 'offline' | 'draining' | 'disabled' } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status, repo_path)
    VALUES (${id}, ${projectId}, ${deviceId}, ${`runner-${id.slice(0, 8)}`}, 'claude-code',
            ${opts.status ?? 'online'}, '/srv/checkout')
  `);
  return id;
}
