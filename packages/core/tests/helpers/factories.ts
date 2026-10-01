import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { OrgMemberRole, ProjectMemberRole } from '../../src/db/schema.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { projectDocumentSchema } from '../../src/project-config/schema.js';
import { AGENT_NAMING_MIN_RUNNER } from '../../src/runners/device-cap.js';
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
  /** Omitted leaves the user UNVERIFIED, which is what most negative cases want. */
  emailVerifiedAt?: Date;
  /** `'agent'` makes every credential this user owns authenticate `agency:'agent'` (ISS-932). */
  kind?: 'human' | 'agent';
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

  const verifiedAt =
    overrides.emailVerifiedAt?.toISOString() ??
    (overrides.kind === 'agent' ? new Date().toISOString() : null);

  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, email_verified_at, kind)
    VALUES (${user.id}, ${user.email}, ${passwordHash}, ${verifiedAt},
            ${overrides.kind ?? 'human'})
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
  /** Seed `projects.agent_config`. */
  agentConfig?: Record<string, unknown>;
  /**
   * The project's policy-v1 at revision 1. Absent seeds `DEFAULT_POLICY`, the document
   * `createProject` writes; `null` seeds none, for a suite about a project with no policy or one
   * standing at a schema that has no `project_policies` table yet.
   */
  policy?: Record<string, unknown> | null;
  /** Seed `projects.environments` — both sides of the deployment, as one document. */
  environments?: Record<string, unknown>;
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

  // `environments` is named only where a caller seeds it: the migration suites stand at a
  // schema that has no such column yet, and naming it unconditionally fails their INSERT.
  const environments =
    overrides.environments === undefined
      ? { columns: sql``, values: sql`` }
      : {
          columns: sql`, environments`,
          values: sql`, ${JSON.stringify(overrides.environments)}::jsonb`,
        };

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, org_id, created_by, agent_config${environments.columns})
    VALUES (${project.id}, ${project.slug}, ${project.name}, ${project.orgId}, ${project.createdBy},
            ${JSON.stringify(overrides.agentConfig ?? {})}::jsonb${environments.values})
  `);
  const policy = overrides.policy === undefined ? DEFAULT_POLICY : overrides.policy;
  if (policy !== null) {
    await db.execute(sql`
      INSERT INTO project_policies (project_id, revision, document, updated_by)
      VALUES (${project.id}, 1, ${JSON.stringify(policy)}::jsonb, ${createdBy})
    `);
  }

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
  /** Runner release this box reports. Defaults to the claim floor. */
  agentVersion?: string | null;
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
  const agentVersion =
    overrides.agentVersion === undefined ? AGENT_NAMING_MIN_RUNNER : overrides.agentVersion;
  await db.execute(sql`
    INSERT INTO devices (id, owner_id, name, platform, status, agent_version)
    VALUES (${device.id}, ${device.ownerId}, ${device.name}, ${device.platform}, ${device.status}, ${agentVersion})
  `);

  return device;
}

/**
 * Bind a device to a project as its runner, which is what a box must be before it may open a run
 * session there (`devices/pool-admission.ts:projectAdmission`).
 */
export async function bindTestRunner(
  db: TestDb,
  args: {
    projectId: string;
    deviceId: string;
    status?: 'online' | 'offline' | 'draining' | 'disabled';
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (gen_random_uuid(), ${args.projectId}, ${args.deviceId}, ${`runner-${randomUUID().slice(0, 8)}`},
            'claude-code', ${args.status ?? 'online'})
  `);
}

/**
 * A project document at revision 1 whose one environment is production and deploys by `trigger`,
 * which is what `pipeline/auto-prod-deploy.ts:productionDeploysOnLand` reads: `on-land` makes the
 * release sweep the only thing that cuts a release there.
 */
export async function seedProductionDeployTrigger(
  db: TestDb,
  projectId: string,
  updatedBy: string,
  trigger: 'on-land' | 'on-request' | 'provider' = 'on-land',
): Promise<void> {
  const example = JSON.parse(
    readFileSync(
      new URL('../../src/project-config/fixtures/examples/forge-dev.project.json', import.meta.url),
      'utf8',
    ),
  );
  const document = projectDocumentSchema.parse({
    ...example,
    project: { id: projectId, slug: `test-${projectId.slice(0, 8)}`, name: 'Test Project' },
    environments: {
      live: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { binding: randomUUID(), trigger },
      },
    },
  });
  await db.execute(sql`
    INSERT INTO project_config_documents (project_id, revision, document, updated_by)
    VALUES (${projectId}, 1, ${JSON.stringify(document)}::jsonb, ${updatedBy})
    ON CONFLICT (project_id) DO UPDATE SET document = EXCLUDED.document,
                                           revision = project_config_documents.revision + 1
  `);
}
