// The demo world a Forge previewing itself serves (REQ-39, `pnpm preview:demo`): a small project with
// its people, requirements, feedback and issues, written through the integration factories into the
// database `DATABASE_URL` names, plus the one member a demo core signs in with no credential
// (src/auth/demo.ts). Run it once on a freshly migrated, throwaway database:
//   tsx tests/helpers/demo-world.ts
// It refuses a database that already holds a user, so it can never write over a real one.

import { sql } from 'drizzle-orm';
import { DEMO_MEMBER_EMAIL } from '../../src/auth/demo-member.js';
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
import { underStrict } from './project-controls.js';

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

/**
 * Two drafts the steward asks about (REQ-48 r3 BC-16), so a judge sees on Approvals what a merge
 * offer is: one repeats ISS-1 and is offered the merge, saying what both are about; the other sits
 * beside ISS-3 with nothing in common, its merge into it is refused by name, and it is asked without.
 */
const STEWARD_DRAFTS = {
  repeats: {
    title: 'Preview opens the issue page in a side frame',
    into: 1,
    shares: 'opening the issue page preview in a frame.',
  },
  beside: { title: 'Export the call list as a spreadsheet', into: 3 },
} as const;

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
  await seedStewardMerges(project.id, owner.id, issues, now);
  return {
    project: { id: project.id, slug: 'demo' },
    member: { id: owner.id, email: owner.email },
  };
}

/** One steward run on a draft, the run its question's answer is logged against. */
async function stewardRunOn(
  projectId: string,
  draft: { id: string; key: string },
): Promise<string> {
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, not_before, started_at, ended_at)
    VALUES (${projectId}, 'issue', ${draft.id}, ${draft.key}, 'standing.stuck', '[]'::jsonb,
            ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
    RETURNING id`);
  if (!run) throw new Error(`the demo seed wrote no steward run on ${draft.key}`);
  return run.id;
}

/** The steward's questions on two drafts, asked through its own door so the merge rule is the live one. */
async function seedStewardMerges(
  projectId: string,
  ownerId: string,
  issues: readonly { id: string; key: string }[],
  now: number,
): Promise<void> {
  const { askStewardDecision } = await import('../../src/steward/decision-ask.js');
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const stewardId = await stewardAccountOf(projectId);
  const drafts: { id: string; key: string }[] = [];
  for (const [i, d] of [STEWARD_DRAFTS.repeats, STEWARD_DRAFTS.beside].entries()) {
    const made = await createTestIssue(projectId, ownerId, issues.length + i + 1, {
      status: 'draft',
      priority: 'medium',
      createdAt: new Date(now - (i + 1) * HOUR),
      mergedAt: null,
    });
    await db.execute(sql`UPDATE issues SET title = ${d.title} WHERE id = ${made.id}`);
    drafts.push(made);
  }
  const [repeats, beside] = drafts;
  const into = (n: number) => issues[n - 1]?.key ?? '';
  if (!repeats || !beside) throw new Error('the demo seed made no steward drafts');
  const ask = async (
    draft: { id: string; key: string },
    merge: { into: string; shares: string } | null,
    why: string,
  ) =>
    askStewardDecision({
      projectId,
      userId: stewardId,
      runId: await stewardRunOn(projectId, draft),
      about: draft.key,
      prompt: merge
        ? `Merge it into ${merge.into}, open it, keep it as a draft, or drop it?`
        : 'Open it, keep it as a draft, or drop it?',
      options: [
        ...(merge
          ? [
              {
                id: `steward.merge:${merge.into}`,
                label: `Merge it into ${merge.into}`,
                shares: merge.shares,
              },
            ]
          : []),
        { id: 'steward.open', label: 'Open it: admit it for work' },
        { id: 'steward.keep', label: 'Keep it as a draft' },
        { id: 'steward.drop', label: 'Drop it: it is not work' },
      ],
      recommendedOptionId: merge ? `steward.merge:${merge.into}` : 'steward.keep',
      why,
      basis: `demo seed: ${draft.key}`,
      serious: true,
    });
  // the steward's decisions reach a person on Needs you: serious, asked on a strict project (REQ-79 BC-13)
  await underStrict(projectId, ownerId, async () => {
    await ask(
      repeats,
      { into: into(STEWARD_DRAFTS.repeats.into), shares: STEWARD_DRAFTS.repeats.shares },
      `${repeats.key} asks for what ${into(STEWARD_DRAFTS.repeats.into)} already delivers.`,
    );
    const refused = await ask(
      beside,
      { into: into(STEWARD_DRAFTS.beside.into), shares: 'the demo project.' },
      'It sits beside an issue about something else.',
    ).then(
      () => null,
      (err: unknown) => String((err as { message?: string }).message ?? err),
    );
    if (!refused?.includes('STEWARD_MERGE_NOT_SAME_SUBJECT')) {
      throw new Error(
        `the demo seed's merge of ${beside.key} into ${into(STEWARD_DRAFTS.beside.into)}, two items about different things, was not refused as STEWARD_MERGE_NOT_SAME_SUBJECT: ${refused ?? 'it was asked'}`,
      );
    }
    await ask(beside, null, 'Nobody has said whether the call list export is wanted yet.');
  });
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
