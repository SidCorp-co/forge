import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ProjectMemberRole } from '../../src/db/schema.js';
import type { TestDb } from './db.js';

/**
 * Inserts against the real `users`, `projects`, and `project_members` tables
 * (Phase 2.1-C + 2.1-D). All factories are deterministic and return the row
 * shape they inserted.
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

export interface TestProject {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
}

export interface CreateTestProjectOverrides {
  id?: string;
  slug?: string;
  name?: string;
}

export async function createTestProject(
  db: TestDb,
  ownerId: string,
  overrides: CreateTestProjectOverrides = {},
): Promise<TestProject> {
  const id = overrides.id ?? randomUUID();
  const project: TestProject = {
    id,
    slug: overrides.slug ?? `test-${id.slice(0, 8)}`,
    name: overrides.name ?? `Test Project ${id.slice(0, 8)}`,
    ownerId,
  };

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, owner_id)
    VALUES (${project.id}, ${project.slug}, ${project.name}, ${project.ownerId})
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
