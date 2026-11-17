// ISS-1256 c9: the module map's Unplaced row rose from 89 to 91 lessons on forge-dev on 2026-11-17,
// each new lesson the steward drafted filed with no module, since nothing asked its grouping for one.
// The grouping is now handed the project's modules and names the one each lesson is about; core sets
// what it named and infers none. Through the steward's pass against real Postgres, the model's
// answers the test's own.
//
// @direct-test-of packages/core/src/steward/lessons-pass.ts
// @direct-test-of packages/core/src/lessons/decide.ts

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestModule, rows } from '../helpers/factories.js';
import {
  correction,
  openLessonsWorld,
  ownProject,
  pass,
  proposal,
} from '../helpers/lessons-world.js';

openLessonsWorld();

const placeOf = async (project: string, sentence: string) =>
  (
    await rows<{ slug: string | null }>(sql`
      SELECT l.slug FROM lessons s LEFT JOIN labels l ON l.id = s.module_id
       WHERE s.project_id = ${project} AND s.sentence = ${sentence}`)
  )[0];

describe("the steward's grouping places each lesson it drafts (ISS-1256 c9)", () => {
  it('is handed the modules, and the lesson sits in the one it named', async () => {
    const own = await ownProject();
    await createTestModule(own.id, 'execution');
    await createTestModule(own.id, 'platform');
    const a = await correction('Declare the run first.', { project: own.id });
    const b = await correction('Declare the run first, again.', { project: own.id });
    const handed: string[] = [];
    const tally = await pass({
      project: own.id,
      seen: (input) =>
        handed.push(
          ...((input as { modules: { slug: string }[] }).modules ?? []).map((m) => m.slug),
        ),
      proposals: [
        { ...proposal('Declare a run before its builder.', [a, b]), module: 'execution' },
      ],
    });
    expect(handed.sort()).toEqual(['execution', 'platform']);
    expect(await placeOf(own.id, 'Declare a run before its builder.')).toEqual({
      slug: 'execution',
    });
    expect(tally.placed).toBe(1);
  });

  it('proposes a lesson whose module is none of the project’s Unplaced, never dropped or placed elsewhere (negative)', async () => {
    const own = await ownProject();
    await createTestModule(own.id, 'execution');
    const a = await correction('Name the unit.', { project: own.id });
    const b = await correction('Name the unit, again.', { project: own.id });
    const tally = await pass({
      project: own.id,
      proposals: [{ ...proposal('Name the unit beside a number.', [a, b]), module: 'billing' }],
    });
    expect(await placeOf(own.id, 'Name the unit beside a number.')).toEqual({ slug: null });
    expect(tally.proposed).toBe(1);
    expect(tally.placed).toBe(0);
  });

  it('leaves a lesson whose grouping named no module Unplaced, a gap shown (boundary)', async () => {
    const own = await ownProject();
    await createTestModule(own.id, 'execution');
    const a = await correction('Cite the hit.', { project: own.id });
    const b = await correction('Cite the hit, again.', { project: own.id });
    await pass({
      project: own.id,
      proposals: [{ ...proposal('Cite each hit you answer from.', [a, b]), module: null }],
    });
    expect(await placeOf(own.id, 'Cite each hit you answer from.')).toEqual({ slug: null });
  });
});
