import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { CLAIM_MIN_RUNNER } from '../../src/runners/device-cap.js';

export async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** Tables whose rows a migration seeds as part of the schema (`schema-outbox.ts:outboxEventTypes`). */
const SEEDED_BY_MIGRATIONS = ['outbox_event_types'];

/** Empties every table the migrations made, keeping the schema, its seeded rows and drizzle's journal. */
export async function truncateAll(): Promise<void> {
  const tables = await rows<{ name: string }>(sql`
    SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT IN ${SEEDED_BY_MIGRATIONS}
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
  opts: { status?: 'online' | 'offline'; agentVersion?: string; name?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO devices (id, owner_id, name, platform, status, agent_version)
    VALUES (${id}, ${ownerId}, ${opts.name ?? `device-${id.slice(0, 8)}`}, 'linux', ${opts.status ?? 'online'},
            ${opts.agentVersion ?? CLAIM_MIN_RUNNER})
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

/**
 * Seeds a status under the kernel's transaction flag (`db/kernel-marker.ts`): for a case whose
 * subject is what a reader does with a row at that status, not how the row got there.
 */
export async function seedIssueStatus(issueId: string, status: string): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`UPDATE issues SET status = ${status} WHERE id = ${issueId}`),
  );
}

/** A person's preferences row, every column at its default. */
export async function createTestPreferences(userId: string): Promise<void> {
  await db.execute(sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`);
}

export interface TestIssueInput {
  status: string;
  createdAt: Date;
  mergedAt?: Date | null;
  waitingKind?: string;
  priority?: string;
  requirementId?: string | null;
}

/** Issue `ISS-<seq>` in the project, inserted at `status` as it stands, not moved there. */
export async function createTestIssue(
  projectId: string,
  createdBy: string,
  seq: number,
  over: TestIssueInput,
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, merged_at, waiting_kind, priority, requirement_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${over.status}, ${createdBy},
            ${over.createdAt.toISOString()}, ${over.mergedAt?.toISOString() ?? null},
            ${over.waitingKind ?? null}, ${over.priority ?? 'medium'}, ${over.requirementId ?? null})
  `);
  return { id, key: `ISS-${seq}` };
}

/** The `issue.statusChanged` activity row a person's move from `from` to `to` leaves at `at`. */
export async function recordStatusMove(
  issueId: string,
  actorId: string,
  from: string,
  to: string,
  at: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
    VALUES (${issueId}, 'user', ${actorId}, 'human', 'issue.statusChanged',
            ${JSON.stringify({ from, to })}::jsonb, ${at.toISOString()})
  `);
}

/** A run a box declared: its run session started at `start`, its run finished at `end` (null: still open). */
export async function createTestRunSession(
  projectId: string,
  deviceId: string,
  start: Date,
  end: Date | null,
): Promise<string> {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', ${end ? 'completed' : 'running'}, ${start.toISOString()},
            ${end?.toISOString() ?? null}, '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${deviceId}, ${runId}, 'run_session', ${end ? 'completed' : 'running'},
            ${start.toISOString()}, ${start.toISOString()})
  `);
  return runId;
}

/** A completed release run that shipped `issueIds` at `at` as `version`. */
export async function createTestRelease(
  projectId: string,
  version: string,
  issueIds: readonly string[],
  at: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${version}, ${at.toISOString()}, ${JSON.stringify({ issueIds })}::jsonb)
  `);
}

/** Requirement `REQ-<seq>`, at draft. */
export async function createTestRequirement(
  projectId: string,
  seq: number,
  title: string,
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO requirements (id, project_id, req_seq, title, status)
    VALUES (${id}, ${projectId}, ${seq}, ${title}, 'draft')
  `);
  return { id, key: `REQ-${seq}` };
}

/** Feedback `FB-<seq>` a person reported, untriaged, or triaged onto `carriers` as an issue route. */
export async function createTestFeedback(
  projectId: string,
  reportedBy: string,
  seq: number,
  carriers: readonly string[] = [],
): Promise<string> {
  await db.transaction(async (tx) => {
    const [made] = (await tx.execute(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, where_seen, status, route, reported_by, reporter_agency)
      VALUES (${projectId}, ${seq}, 'bug', ${`feedback ${seq}`}, 'The board',
              ${carriers.length ? 'triaged' : 'new'}, ${carriers.length ? 'issue' : null}, ${reportedBy}, 'human')
      RETURNING id
    `)) as unknown as { id: string }[];
    for (const issueId of carriers) {
      await tx.execute(sql`
        INSERT INTO feedback_route_issues (feedback_id, issue_id) VALUES (${made?.id}, ${issueId})
      `);
    }
  });
  return `FB-${seq}`;
}
