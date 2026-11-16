/**
 * The texts every prompt of a project carries, each against its cap (ISS-1251): the always-on
 * knowledge (its org's rulings and its own), the lessons map a run is handed, and each skill's
 * always-on part. A pile past its cap is due for consolidation, folding what holds into the teaching
 * that owns it or retiring it, never for a cut: this read says which are due, and by how much.
 */

import { TIER0_MAP_MAX_CHARS } from '@forge/contracts/capability-cards';
import { type PileRow, type PilesView, SKILL_ALWAYS_ON_MAX_CHARS } from '@forge/contracts/door-use';
import { ALWAYS_INJECT_MAX_CHARS } from '@forge/contracts/knowledge';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { selectAlwaysInjectFromKnowledge, selectLessonEntries } from '../knowledge/index.js';
import { lessonsMapOverflow, restLessonDoors } from '../lessons/index.js';
import type { DoorCatalog, Tier0Map } from '../lib/door-catalog.js';
import { doorCalls, MAP_AUDIENCES, tier0Maps } from './door-use.js';

/** The audience whose map is the widest: a run, which builds issues and works in any area. */
const RUN_AUDIENCE = { produces: ['issue'] as const, area: 'any' as const };

export async function readPiles(projectId: string, catalog: DoorCatalog): Promise<PilesView> {
  const [always, lessons, skills] = await Promise.all([
    selectAlwaysInjectFromKnowledge(projectId),
    selectLessonEntries(projectId),
    db.execute(sql`
      SELECT s.name, length(s.description)::int AS size FROM skills s
      WHERE s.scope = 'global' OR s.project_id = ${projectId}::uuid
      ORDER BY 2 DESC, 1`) as unknown as Promise<{ name: string; size: number }[]>,
  ]);
  const maps = await tier0Maps(projectId, catalog, await doorCalls(projectId, catalog, 30));
  const knowledge = always.reduce((n, f) => n + f.text.length, 0);
  const map = lessonsMapOverflow(lessons, { ...RUN_AUDIENCE, ...restLessonDoors(projectId) });
  const piles: PileRow[] = [
    {
      pile: 'always_knowledge',
      name: 'always-on knowledge',
      size: knowledge,
      cap: ALWAYS_INJECT_MAX_CHARS,
      items: always.length,
      carried: always.length,
      over: knowledge > ALWAYS_INJECT_MAX_CHARS,
    },
    {
      pile: 'lessons_map',
      name: 'lessons map (runs)',
      size: map.size,
      cap: map.cap,
      items: map.reach,
      carried: map.named,
      over: map.named < map.reach,
    },
    ...MAP_AUDIENCES.map((audience) => {
      const map = maps.get(audience) as Tier0Map;
      return {
        pile: 'tier0_map' as const,
        name: `map (${audience})`,
        size: map.text.length,
        cap: TIER0_MAP_MAX_CHARS,
        items: map.reach,
        carried: map.carried.length,
        // a map that cannot carry every card it teaches is due for merging, never cut
        over: map.carried.length < map.reach,
      };
    }),
    ...skills.map((s) => ({
      pile: 'skill_always_on' as const,
      name: s.name,
      size: s.size,
      cap: SKILL_ALWAYS_ON_MAX_CHARS,
      items: 1,
      carried: 1,
      over: s.size > SKILL_ALWAYS_ON_MAX_CHARS,
    })),
  ];
  return { projectId, piles };
}
