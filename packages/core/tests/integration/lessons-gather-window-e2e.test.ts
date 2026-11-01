// ISS-867 (REQ-50 r2 BC-2): the steward's grouping reads the NEWEST open corrections, so a correction
// said today reaches it however many lone ones wait behind. Read oldest-first, a project past the
// window handed the same oldest corrections to every pass and nothing said after them was grouped:
// forge had 193 corrections in October and no lesson. Against real Postgres through the steward's pass.
//
// @direct-test-of packages/core/src/lessons/gather.ts

import { describe, expect, it } from 'vitest';
import { correction, openLessonsWorld, ownProject, pass } from '../helpers/lessons-world.js';

openLessonsWorld();

const DAY = 86_400_000;

describe('the grouping reads the newest corrections (ISS-867)', () => {
  it('hands the pass the newest window, oldest of them first, and leaves the oldest past it', async () => {
    const { GATHER_CORRECTIONS } = await import('../../src/lessons/index.js');
    const own = await ownProject();
    const past = GATHER_CORRECTIONS + 5;
    const start = Date.now() - past * DAY;
    const ids: string[] = [];
    for (let i = 0; i < past; i += 1) {
      ids.push(
        await correction(`Lone correction ${i}.`, {
          project: own.id,
          at: new Date(start + i * DAY),
        }),
      );
    }
    const asked: string[] = [];
    await pass({
      project: own.id,
      seen: (input) => asked.push(...input.corrections.map((c) => String(c.id))),
    });
    expect(asked).toHaveLength(GATHER_CORRECTIONS);
    // the newest said is read, and the five oldest wait for a newer one to repeat them
    expect(asked).toEqual(ids.slice(past - GATHER_CORRECTIONS));
    expect(asked).not.toContain(ids[0]);
  });

  it('reads every open correction when fewer than the window wait (boundary)', async () => {
    const own = await ownProject();
    const a = await correction('Say the unit.', {
      project: own.id,
      at: new Date(Date.now() - DAY),
    });
    const b = await correction('Say the unit, again.', { project: own.id });
    const asked: string[] = [];
    await pass({
      project: own.id,
      seen: (input) => asked.push(...input.corrections.map((c) => String(c.id))),
    });
    expect(asked).toEqual([a, b]);
  });
});
