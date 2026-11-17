// ISS-1251 c5: a cap triggers merging, never truncation. On forge-dev at dev.709 the always-on
// knowledge was 9468 of 6000 characters and nothing named what ran past it; the run's lessons map
// was cut to "and 45 more". Here a project's always-on knowledge past its cap is served whole, the
// pile names the entries past it, and the steward's pass opens one item carrying the merges it
// proposes over those entries for the cleanup run to apply; no entry is cut or archived by it.
// Against real Postgres, through the piles door and the steward's pass; the model's merges are the
// test's own.
//
// @direct-test-of packages/core/src/steward/lessons-piles.ts
// @direct-test-of packages/core/src/metrics/piles.ts

import type { PilesView } from '@forge/contracts/door-use';
import { ALWAYS_INJECT_MAX_CHARS } from '@forge/contracts/knowledge';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ok } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import { openLessonsWorld, pass, say, w } from '../helpers/lessons-world.js';

openLessonsWorld();

describe('always-on knowledge past its cap is served whole, named past it, and merged by proposal (c5)', () => {
  it('names the entries past the cap and records the steward’s merges over them, cutting none', async () => {
    const body = (i: number) =>
      `Rule ${i} about the ward rota, carried by every prompt. `.repeat(35);
    const slugs: string[] = [];
    for (let i = 0; slugs.length * body(0).length <= ALWAYS_INJECT_MAX_CHARS; i++) {
      slugs.push(`rota-${i}`);
      await rows(sql`
        INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection)
        VALUES (${w.projectId}, ${`rota-${i}`}, ${`Rota ${i}`}, ${body(i)}, 'guide', 'always')
        RETURNING id`);
    }
    const read = ok(await say('owner', 'GET', `/api/projects/${w.projectId}/metrics/piles`));
    const knowledge = (read as unknown as PilesView).piles.find(
      (p) => p.pile === 'always_knowledge',
    );
    expect(knowledge?.over).toBe(true);
    expect(knowledge?.past.length).toBeGreaterThan(0);
    expect(slugs).toContain(knowledge?.past[0]);
    const asked: string[] = [];
    await pass({
      merge: (input) => {
        const { pile, entries } = input as { pile: { pile: string }; entries: { key: string }[] };
        asked.push(pile.pile);
        if (pile.pile !== 'always_knowledge') return null;
        expect(entries.map((e) => e.key)).toEqual(expect.arrayContaining(slugs));
        return [{ from: ['rota-0', 'rota-1'], into: 'rota-0', says: 'The ward rota, said once.' }];
      },
    });
    expect(asked).toContain('always_knowledge');
    const [debt] = await rows<{ detail: string }>(sql`
      SELECT detail FROM delivery_debts
       WHERE project_id = ${w.projectId} AND check_name = 'pile:always_knowledge'`);
    expect(debt?.detail).toContain(`Served past the cap: ${knowledge?.past.join(', ')}.`);
    expect(debt?.detail).toContain(
      'Merges proposed: (1) rota-0 + rota-1 into rota-0: "The ward rota, said once."',
    );
    const [kept] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM knowledge_entries
       WHERE project_id = ${w.projectId} AND slug LIKE 'rota-%' AND archived_at IS NULL`);
    expect(kept?.n).toBe(slugs.length);
  });
});
