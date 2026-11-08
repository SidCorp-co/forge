// REQ-50 r2 BC-6, ISS-1136, ISS-1167: a repeat, or three corrections, becomes a check in code, only
// for a lesson whose record says it is about the app's behaviour; a process lesson, about an agent's
// judgement or a Forge step, is routed to Forge once and drafts nothing in the project's backlog; one
// whose record does not say is classified by the steward first. Through the app's own routes against
// real Postgres (`../helpers/lessons-world.ts`).
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

// ISS-1136: only a lesson about the app's behaviour becomes a check in the project's code; a process
// lesson is routed to Forge, once. ISS-1167: which one it is reads from its record, never its scope
describe('a repeat, or three corrections, becomes a check in code (BC-6)', () => {
  const area = () => ({ scope: 'area', areaId: w.areaA, itemKind: null, about: 'app' });
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

  /** A lesson drafted before its record said what it is about, as older rows read. */
  const unclassify = (id: string) => rows(sql`UPDATE lessons SET about = NULL WHERE id = ${id}`);
  const appAnswer = { about: 'app', reason: 'The corrections name a screen of the app.' };

  it('files an unclassified lesson neither way until the steward classifies it, then by its record', async () => {
    const n = await approved('Show the keep and kill thresholds on the campaign page.');
    const id = (await lesson(n)).id as string;
    await unclassify(id);
    const repeat = await correction('The campaign page hides its thresholds again.');
    const waiting = await pass({ links: [{ correction: repeat, lesson: n }] });
    expect(waiting).toMatchObject({ unclassified: 1, checks: 0 });
    expect(await lesson(n)).toMatchObject({
      about: null,
      check_issue_id: null,
      routed_feedback_id: null,
    });
    const filed = await pass({ classify: appAnswer });
    expect(filed).toMatchObject({ unclassified: 0, checks: 1 });
    expect((await lesson(n)).about, 'the classification is on the record').toBe('app');
    expect(await checkOf(id)).toHaveLength(1);
  });

  it('drafts the check here for a lesson routed to Forge before it was classified app, once, keeping the routed record', async () => {
    await forgeHome();
    const n = await approved('Give a campaign a status and a kill rule.');
    const id = (await lesson(n)).id as string;
    const repeat = await correction('The campaign still has no status.');
    await pass({ links: [{ correction: repeat, lesson: n }] });
    const routed = (await lesson(n)).routed_feedback_id;
    expect(routed, 'routed to Forge as a process lesson').not.toBeNull();
    await unclassify(id);
    expect((await pass({ classify: appAnswer })).checks).toBe(1);
    expect(await lesson(n)).toMatchObject({ about: 'app', routed_feedback_id: routed });
    expect((await lesson(n)).check_issue_id).not.toBeNull();
    expect((await pass({ classify: appAnswer })).checks, 'drafted once').toBe(0);
    expect(await checkOf(id)).toHaveLength(1);
    const feedback = await rows(sql`
      SELECT id FROM feedback WHERE signal_key = ${`lesson-process/${id}`}`);
    expect(feedback, 'routed once').toHaveLength(1);
  });

  it('routes nothing again for a routed lesson the steward classifies process (boundary)', async () => {
    await forgeHome();
    const n = await approved('Read the call sites before judging an upgrade.');
    const id = (await lesson(n)).id as string;
    const repeat = await correction('An upgrade was judged blind again.');
    await pass({ links: [{ correction: repeat, lesson: n }] });
    await unclassify(id);
    const again = await pass({ classify: { about: 'process', reason: 'It is about judging.' } });
    expect(again.checks).toBe(0);
    expect(await lesson(n)).toMatchObject({ about: 'process', check_issue_id: null });
    expect(await checkOf(id)).toHaveLength(0);
  });
});

// ISS-1167: whoever drafts a lesson says what it is about; a draft that does not is refused by name
describe('a lesson says what it is about when it is drafted', () => {
  it('proposes no lesson from a group whose answer names no kind, or an unknown one (negative)', async () => {
    const a = [await correction('Missing kind (1)'), await correction('Missing kind (2)')];
    const b = [await correction('Wrong kind (1)'), await correction('Wrong kind (2)')];
    const { about: _none, ...unsaid } = proposal('Say the kind of every lesson.', a);
    const tally = await pass({
      proposals: [unsaid, { ...proposal('Name the screen kind.', b), about: 'screen' }],
    });
    expect(tally).toMatchObject({ proposed: 0, dropped: 2 });
  });

  it('refuses a proposal by name with the valid shape', async () => {
    const said = await correction('An unknown kind.');
    const { proposeLesson } = await import('../../src/lessons/index.js');
    const refused = await proposeLesson({
      projectId: w.projectId,
      actor: { userId: w.stewardId, agency: 'agent' },
      body: {
        sentence: 'Say what a lesson is about.',
        scope: { kind: 'project' },
        about: 'screen' as never,
        corrections: [said],
      },
    }).then(
      () => [],
      (err: { refusals?: { code: string; detail?: string }[] }) => err.refusals ?? [],
    );
    expect(refused.map((r) => r.code)).toEqual(['LESSON_ABOUT_INVALID']);
    expect(refused[0]?.detail).toContain('about: app | process');
  });
});
