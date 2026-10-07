import { sql } from 'drizzle-orm';
import { closeDb } from '../../src/db/client.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestPreferences,
  createTestProject,
  createTestRelease,
  createTestRequirement,
  createTestRunSession,
  createTestUser,
  recordStatusMove,
  rows,
} from './factories.js';

const HOUR = 3_600_000;

/** The seed step whose write the base schema refused, with what Postgres said as its cause. */
export class SeedRefused extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(`seeding stopped at ${step}`, { cause });
  }
}

async function step<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    throw new SeedRefused(name, err);
  }
}

/**
 * One of every row the integration factories build, written through those factories into the
 * database `DATABASE_URL` names: the rows a deployed database already holds when a new migration
 * reaches it. Returns each public table that now holds rows, with its count.
 */
export async function seedFactoryWorld(): Promise<Record<string, number>> {
  try {
    const owner = await step('createTestUser (users, human)', () =>
      createTestUser({ verified: true }),
    );
    const agent = await step('createTestUser (users, agent)', () =>
      createTestUser({ kind: 'agent' }),
    );
    await step('createTestPreferences (user_preferences)', () => createTestPreferences(owner.id));
    await step('createTestPreferences (user_preferences)', () => createTestPreferences(agent.id));
    const project = await step(
      'createTestProject (organizations, organization_members, projects, project_policies)',
      () => createTestProject(owner.id),
    );
    await step('addProjectMember (project_members)', () =>
      addProjectMember(project.id, agent.id, 'member'),
    );
    const device = await step('createTestDevice (devices)', () => createTestDevice(owner.id));
    await step('bindTestRunner (runners)', () => bindTestRunner(project.id, device));
    const req = await step('createTestRequirement (requirements)', () =>
      createTestRequirement(project.id, 1, 'A seeded requirement'),
    );
    const now = Date.now();
    const open = await step('createTestIssue (issues)', () =>
      createTestIssue(project.id, owner.id, 1, {
        status: 'open',
        createdAt: new Date(now - 2 * HOUR),
        requirementId: req.id,
      }),
    );
    const landed = await step('createTestIssue (issues)', () =>
      createTestIssue(project.id, owner.id, 2, {
        status: 'closed',
        createdAt: new Date(now - 30 * HOUR),
        mergedAt: new Date(now - 24 * HOUR),
      }),
    );
    await step('recordStatusMove (activity_log)', () =>
      recordStatusMove(landed.id, owner.id, 'open', 'in_progress', new Date(now - 26 * HOUR)),
    );
    await step('createTestRunSession (pipeline_runs, agent_sessions)', () =>
      createTestRunSession(
        project.id,
        device,
        new Date(now - 26 * HOUR),
        new Date(now - 25 * HOUR),
      ),
    );
    await step('createTestRelease (pipeline_runs)', () =>
      createTestRelease(project.id, '0.0.1', [landed.id], new Date(now - 23 * HOUR)),
    );
    await step('createTestFeedback (feedback, feedback_route_issues)', () =>
      createTestFeedback(project.id, owner.id, 1, [open.id]),
    );
    await step('createTestFeedback (feedback)', () => createTestFeedback(project.id, agent.id, 2));
    return await heldRows();
  } finally {
    await closeDb();
  }
}

async function heldRows(): Promise<Record<string, number>> {
  const tables = await rows<{ name: string }>(sql`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  const counts = await rows<{ name: string; n: number }>(
    sql.raw(
      tables
        .map((t) => `SELECT '${t.name}' AS name, count(*)::int AS n FROM public."${t.name}"`)
        .join(' UNION ALL '),
    ),
  );
  return Object.fromEntries(counts.filter((c) => c.n > 0).map((c) => [c.name, c.n]));
}
