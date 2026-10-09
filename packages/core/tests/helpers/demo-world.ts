// The demo world a Forge previewing itself serves (REQ-39, `pnpm preview:demo`): a small project with
// its people, requirements, feedback and issues, written through the integration factories into the
// database `DATABASE_URL` names, plus the one member a demo core signs in with no credential
// (src/auth/demo.ts). Run it once on a freshly migrated, throwaway database:
//   tsx tests/helpers/demo-world.ts
// It refuses a database that already holds a user, so it can never write over a real one.

import { sql } from 'drizzle-orm';
import { DEMO_MEMBER_EMAIL } from '../../src/auth/demo.js';
import { closeDb, db } from '../../src/db/client.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestPreferences,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from './factories.js';

const HOUR = 3_600_000;

/** The people, with the role each holds on the demo project. */
const PEOPLE = [
  { email: DEMO_MEMBER_EMAIL, name: 'Demo Member', role: 'owner' },
  { email: 'mai.tran@demo.forge.local', name: 'Mai Tran', role: 'admin' },
  { email: 'liam.ortiz@demo.forge.local', name: 'Liam Ortiz', role: 'member' },
  { email: 'sana.okoye@demo.forge.local', name: 'Sana Okoye', role: 'viewer' },
] as const;

const REQUIREMENTS = [
  { title: 'See a change live before it ships' },
  { title: 'Reporters hear back when their feedback is fixed' },
  { title: 'A release page anyone on the team can read' },
] as const;

const ISSUES = [
  {
    title: 'Preview opens the issue page in a frame',
    status: 'in_progress',
    priority: 'high',
    req: 0,
  },
  {
    title: 'Idle previews close after the project setting',
    status: 'open',
    priority: 'medium',
    req: 0,
  },
  { title: 'Notify the reporter when the fix lands', status: 'open', priority: 'medium', req: 1 },
  {
    title: 'Release notes list every merged issue',
    status: 'awaiting_release',
    priority: 'low',
    req: 2,
  },
  { title: 'Version number shows in the footer', status: 'closed', priority: 'low', req: 2 },
] as const;

const FEEDBACK = [
  { title: 'The board scrolls sideways on a phone', carry: [0] },
  { title: 'I could not find where to report a problem', carry: [] },
  { title: 'Release page shows an old version', carry: [3] },
] as const;

export interface DemoWorld {
  project: { id: string; slug: string };
  member: { id: string; email: string };
}

/** Writes the demo world, refusing by name a database that already holds a user. */
export async function seedDemoWorld(): Promise<DemoWorld> {
  const [held] = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM users`);
  if (held && held.n > 0) {
    throw new Error(
      `the demo seed refuses a database that already holds ${held.n} user(s): it writes only into a freshly migrated, throwaway one (DATABASE_URL is not one)`,
    );
  }
  const users: { id: string; email: string; role: (typeof PEOPLE)[number]['role'] }[] = [];
  for (const person of PEOPLE) {
    const user = await createTestUser({ email: person.email, verified: true });
    await db.execute(sql`UPDATE users SET display_name = ${person.name} WHERE id = ${user.id}`);
    await createTestPreferences(user.id);
    users.push({ ...user, role: person.role });
  }
  const [owner] = users;
  if (!owner) throw new Error('the demo seed has no people');
  const project = await createTestProject(owner.id);
  await db.execute(sql`
    UPDATE projects SET slug = 'demo', name = 'Demo Project' WHERE id = ${project.id}
  `);
  await db.execute(sql`
    UPDATE organizations SET slug = 'demo-org', name = 'Demo Org' WHERE id = ${project.orgId}
  `);
  for (const user of users.slice(1)) await addProjectMember(project.id, user.id, user.role);

  const now = Date.now();
  const requirements: { id: string; key: string }[] = [];
  for (const [i, r] of REQUIREMENTS.entries()) {
    const made = await createTestRequirement(project.id, i + 1, r.title);
    requirements.push(made);
  }
  const issues: { id: string; key: string }[] = [];
  for (const [i, issue] of ISSUES.entries()) {
    const made = await createTestIssue(project.id, owner.id, i + 1, {
      status: issue.status,
      priority: issue.priority,
      createdAt: new Date(now - (ISSUES.length - i) * 5 * HOUR),
      mergedAt: issue.status === 'closed' ? new Date(now - 6 * HOUR) : null,
      requirementId: requirements[issue.req]?.id ?? null,
    });
    await db.execute(sql`UPDATE issues SET title = ${issue.title} WHERE id = ${made.id}`);
    issues.push(made);
  }
  for (const [i, fb] of FEEDBACK.entries()) {
    const carriers = fb.carry.map((n) => issues[n]?.id).filter((id): id is string => !!id);
    await createTestFeedback(project.id, owner.id, i + 1, carriers);
    await db.execute(
      sql`UPDATE feedback SET title = ${fb.title} WHERE project_id = ${project.id} AND fb_seq = ${i + 1}`,
    );
  }
  return {
    project: { id: project.id, slug: 'demo' },
    member: { id: owner.id, email: owner.email },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const world = await seedDemoWorld();
    process.stdout.write(
      `[demo-seed] project ${world.project.slug}, member ${world.member.email}\n`,
    );
  } finally {
    await closeDb();
  }
}
