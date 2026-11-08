// REQ-50 r2 BC-6, ISS-1136: a repeat, or three corrections, becomes a check in code, only for a
// lesson about a product area's behaviour; a process lesson, about an agent's judgement or a Forge
// step, is routed to Forge once and drafts nothing in the project's backlog. Through the app's own
// routes against real Postgres (`../helpers/lessons-world.ts`).
//
// @direct-test-of packages/core/src/lessons/gather.ts
// @direct-test-of packages/core/src/steward/lessons-pass.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Doc } from '../helpers/ecosystem-world.js';
import { createTestProject, rows, seedIssueStatus } from '../helpers/factories.js';
import {
  approve,
  approved,
  correction,
  lesson,
  numberOf,
  openLessonsWorld,
  pass,
  proposal,
  w,
} from '../helpers/lessons-world.js';

openLessonsWorld();

// ISS-1136: only a lesson about a product area's behaviour becomes a check in the project's code; a
// process lesson (scoped to the project or to a kind of agent output) is routed to Forge, once
describe('a repeat, or three corrections, becomes a check in code (BC-6)', () => {
  const area = () => ({ scope: 'area', areaId: w.areaA, itemKind: null });
  const checkOf = async (id: string) =>
    rows<{ id: string; title: string; status: string }>(sql`
      SELECT id, title, status FROM issues WHERE project_id = ${w.projectId} AND detector_key = ${`lesson-check/${id}`}`);

  it('files one draft check for a lesson corrected again after approval, and never again, even once dropped', async () => {
    const n = await approved('Show the ward on the wristband.', area());
    const repeat = await correction('The wristband has no ward again.');
    await pass({ links: [{ correction: repeat, lesson: n }] });
    const view = await lesson(n);
    expect(view.corrections).toHaveLength(3);
    expect(view.check_issue_id).not.toBeNull();
    const [issue] = await checkOf(view.id as string);
    expect(issue).toMatchObject({
      status: 'draft',
      title: 'Add a check: Show the ward on the wristband.',
    });
    expect((await pass({})).checks).toBe(0);
    await seedIssueStatus(issue?.id as string, 'dropped');
    expect((await pass({})).checks).toBe(0);
    expect(await checkOf(view.id as string)).toHaveLength(1);
  });

  it('files a check for a lesson learned from three corrections, and none for one learned from two', async () => {
    const two = await approved('Name the ward in the letter subject.', area());
    const three = [
      await correction('Bed is missing (1)'),
      await correction('Bed is missing (2)'),
      await correction('Bed is missing (3)'),
    ];
    await pass({
      proposals: [proposal('Name the bed in every handover.', three, area())],
      review: (i) =>
        (i.lesson as Doc).sentence === 'Name the bed in every handover.' ? approve() : null,
    });
    const n = await numberOf('Name the bed in every handover.');
    expect((await lesson(n)).check_issue_id).not.toBeNull();
    expect((await lesson(two)).check_issue_id).toBeNull();
  });

  /** Forge's own home project, where a process lesson is routed as feedback. */
  const forgeHome = async () => {
    const home = (await createTestProject(w.ownerId)).id;
    await rows(sql`
      INSERT INTO instance_settings (id, forge_home_project_id, revision, updated_by)
      VALUES (1, ${home}, 1, ${w.ownerId})
      ON CONFLICT (id) DO UPDATE SET forge_home_project_id = EXCLUDED.forge_home_project_id`);
    return home;
  };

  it('routes a process lesson to Forge once, and drafts no check in the project', async () => {
    const home = await forgeHome();
    const n = await approved('Judge a contract upgrade against its call sites.');
    const repeat = await correction('The upgrade was judged without its call sites again.');
    await pass({ links: [{ correction: repeat, lesson: n }] });
    const view = await lesson(n);
    expect(view.check_issue_id, 'no "Add a check" draft in the project').toBeNull();
    expect(await checkOf(view.id as string)).toHaveLength(0);
    const [routed] = await rows<{ project_id: string; title: string }>(sql`
      SELECT f.project_id, f.title FROM feedback f JOIN lessons l ON l.routed_feedback_id = f.id
       WHERE l.id = ${view.id as string}`);
    expect(routed).toMatchObject({
      project_id: home,
      title: 'A Forge step keeps being corrected: Judge a contract upgrade against its call sites.',
    });
    expect((await pass({})).checks, 'routed once').toBe(0);
  });

  // ISS-1167: what a lesson is about is on its record, set by the steward that drafts it; its scope
  // says only where it applies. Agenfold's L-25 and L-29, scoped to the project and about its screens,
  // were routed to Forge as FB-588 and FB-589
  it('drafts the check in its own project for a project-scoped lesson whose record says app', async () => {
    await forgeHome();
    const sentence = 'Show every task that waits on the operator on one screen.';
    const said = [
      await correction('The tasks waiting on me are split across three screens.'),
      await correction('There is no Tasks screen.'),
      await correction('I could not find what waits on me.'),
    ];
    await pass({
      proposals: [{ ...proposal(sentence, said), about: 'app' }],
      review: (i) => ((i.lesson as Doc).sentence === sentence ? approve() : null),
    });
    const view = await lesson(await numberOf(sentence));
    expect(view.scope_kind).toBe('project');
    const routed = await rows<{ project_id: string }>(sql`
      SELECT f.project_id FROM feedback f JOIN lessons l ON l.routed_feedback_id = f.id
       WHERE l.id = ${view.id as string}`);
    expect(routed, 'an app lesson is never routed to Forge').toEqual([]);
    const [issue] = await checkOf(view.id as string);
    expect(issue, 'its "Add a check" draft is in its own project').toMatchObject({
      status: 'draft',
      title: `Add a check: ${sentence}`,
    });
  });
});
