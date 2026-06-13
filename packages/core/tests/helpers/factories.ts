import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { OrgMemberRole, ProjectMemberRole } from '../../src/db/schema.js';
import type { TestDb } from './db.js';

/**
 * Inserts against the real `users`, `organizations`, `organization_members`,
 * `projects`, and `project_members` tables. All factories are deterministic
 * and return the row shape they inserted.
 *
 * Org-level authz: every project belongs to an organization (`projects.org_id`
 * NOT NULL) and `projects.owner_id` was replaced by the audit-only
 * `created_by`. `createTestProject` seeds a backing org (with the creator as
 * org `owner`) automatically unless an explicit `orgId` override is given.
 */

export interface TestUser {
  id: string;
  email: string;
}

export interface CreateTestUserOverrides {
  id?: string;
  email?: string;
  passwordHash?: string;
}

export async function createTestUser(
  db: TestDb,
  overrides: CreateTestUserOverrides = {},
): Promise<TestUser> {
  const user: TestUser = {
    id: overrides.id ?? randomUUID(),
    email: overrides.email ?? `user-${randomUUID()}@test.forge.local`,
  };
  const passwordHash = overrides.passwordHash ?? '!test-not-a-real-hash';

  await db.execute(sql`
    INSERT INTO users (id, email, password_hash)
    VALUES (${user.id}, ${user.email}, ${passwordHash})
  `);

  return user;
}

export interface TestOrg {
  id: string;
  slug: string;
  name: string;
  isPersonal: boolean;
  createdBy: string;
}

export interface SeedOrgOverrides {
  id?: string;
  slug?: string;
  name?: string;
  isPersonal?: boolean;
  /** Role granted to `ownerUserId` via organization_members (default 'owner'). */
  ownerRole?: OrgMemberRole;
}

/**
 * Inserts an organization plus an `organization_members` row for
 * `ownerUserId` (role `owner` by default). Use before inserting projects —
 * `projects.org_id` is NOT NULL.
 */
export async function seedOrg(
  db: TestDb,
  ownerUserId: string,
  overrides: SeedOrgOverrides = {},
): Promise<TestOrg> {
  const id = overrides.id ?? randomUUID();
  const org: TestOrg = {
    id,
    slug: overrides.slug ?? `org-${id.slice(0, 8)}`,
    name: overrides.name ?? `Test Org ${id.slice(0, 8)}`,
    isPersonal: overrides.isPersonal ?? false,
    createdBy: ownerUserId,
  };

  await db.execute(sql`
    INSERT INTO organizations (id, slug, name, is_personal, created_by)
    VALUES (${org.id}, ${org.slug}, ${org.name}, ${org.isPersonal}, ${org.createdBy})
  `);
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (${org.id}, ${ownerUserId}, ${overrides.ownerRole ?? 'owner'})
  `);

  return org;
}

export interface TestOrgMember {
  orgId: string;
  userId: string;
  role: OrgMemberRole;
}

export async function createTestOrgMember(
  db: TestDb,
  args: { orgId: string; userId: string; role?: OrgMemberRole },
): Promise<TestOrgMember> {
  const member: TestOrgMember = {
    orgId: args.orgId,
    userId: args.userId,
    role: args.role ?? 'member',
  };

  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (${member.orgId}, ${member.userId}, ${member.role})
  `);

  return member;
}

export interface TestProject {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  /** Audit-only creator (`projects.created_by`) — carries no authz semantics. */
  createdBy: string;
}

export interface CreateTestProjectOverrides {
  id?: string;
  slug?: string;
  name?: string;
  /**
   * Existing organization to attach the project to. When omitted, a fresh org
   * is seeded with `createdBy` as org `owner` (the common single-user case).
   */
  orgId?: string;
}

export async function createTestProject(
  db: TestDb,
  createdBy: string,
  overrides: CreateTestProjectOverrides = {},
): Promise<TestProject> {
  const id = overrides.id ?? randomUUID();
  const orgId = overrides.orgId ?? (await seedOrg(db, createdBy)).id;
  const project: TestProject = {
    id,
    slug: overrides.slug ?? `test-${id.slice(0, 8)}`,
    name: overrides.name ?? `Test Project ${id.slice(0, 8)}`,
    orgId,
    createdBy,
  };

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, org_id, created_by)
    VALUES (${project.id}, ${project.slug}, ${project.name}, ${project.orgId}, ${project.createdBy})
  `);

  return project;
}

export interface TestProjectMember {
  userId: string;
  projectId: string;
  role: ProjectMemberRole;
}

export interface CreateTestProjectMemberOverrides {
  role?: ProjectMemberRole;
}

export async function createTestProjectMember(
  db: TestDb,
  args: { userId: string; projectId: string } & CreateTestProjectMemberOverrides,
): Promise<TestProjectMember> {
  const member: TestProjectMember = {
    userId: args.userId,
    projectId: args.projectId,
    role: args.role ?? 'member',
  };

  await db.execute(sql`
    INSERT INTO project_members (user_id, project_id, role)
    VALUES (${member.userId}, ${member.projectId}, ${member.role})
  `);

  return member;
}

export interface TestDevice {
  id: string;
  ownerId: string;
  name: string;
  platform: 'macos' | 'linux' | 'windows';
  status: 'online' | 'offline' | 'revoked';
}

export interface CreateTestDeviceOverrides {
  id?: string;
  name?: string;
  platform?: TestDevice['platform'];
  status?: TestDevice['status'];
}

export async function createTestDevice(
  db: TestDb,
  ownerId: string,
  overrides: CreateTestDeviceOverrides = {},
): Promise<TestDevice> {
  const device: TestDevice = {
    id: overrides.id ?? randomUUID(),
    ownerId,
    name: overrides.name ?? `device-${randomUUID().slice(0, 8)}`,
    platform: overrides.platform ?? 'linux',
    status: overrides.status ?? 'online',
  };
  const tokenHash = `!test-device-hash-${device.id}`;
  const tokenPrefix = device.id.slice(0, 8);

  await db.execute(sql`
    INSERT INTO devices (id, owner_id, name, platform, token_hash, token_prefix, status)
    VALUES (${device.id}, ${device.ownerId}, ${device.name}, ${device.platform}, ${tokenHash}, ${tokenPrefix}, ${device.status})
  `);

  return device;
}
