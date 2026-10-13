/**
 * The score of one takeable issue, as parts (ISS-1336). Nothing here reads a database or a clock:
 * the maintainer hands it what it read, and `now` is passed to the one term a clock moves.
 *
 * The parts and their order are `forge next`'s own (`plugin/src/rank/score.mjs`): priority, kind,
 * complexity, module, age, reopened, blocks. `reading` is a seventh the client adds from one
 * checkout's review mark, which no server can see, and is named in the answer's `excluded` list.
 */

import { type ModuleDefinition, moduleWeightOf, type RankWeights, UNSET } from './rank-weights.js';

const DAY_MS = 86_400_000;

export interface RankPart {
  name: string;
  said: string;
  points: number;
}

export interface RankIssueFacts {
  priority: string | null;
  category: string | null;
  complexity: string | null;
  reopenCount: number;
}

const pointsOf = (table: Record<string, number>, name: string, fallback = 0): number =>
  Object.hasOwn(table, name) ? (table[name] as number) : fallback;

/** What the module term read, said in words the answer can print beside its points. */
export interface ModuleTerm {
  said: string;
  points: number;
}

/**
 * The term for an issue's primary module. No `rank.module` table weighs nothing, and so does a
 * project that defines no module, both said rather than scored as if a row had answered.
 */
export function moduleTermOf(
  module: ModuleDefinition | null,
  modules: ModuleDefinition[],
  table: Record<string, number> | null,
): ModuleTerm {
  if (table === null) return { said: 'no rank.module table', points: 0 };
  if (modules.length === 0) return { said: 'no module defined', points: 0 };
  const weight = moduleWeightOf(module, modules, table);
  if (!module) return { said: `none (${UNSET})`, points: weight.points };
  if (weight.via) return { said: `${module.name} (${weight.via}'s row)`, points: weight.points };
  return {
    said: weight.row === UNSET ? `${module.name} (${UNSET})` : module.name,
    points: weight.points,
  };
}

/** Every term but age, in the order they print, and their sum. */
export function staticScoreOf(
  facts: RankIssueFacts,
  chainCount: number,
  moduleTerm: ModuleTerm,
  weights: RankWeights,
): { total: number; parts: RankPart[] } {
  const complexity = facts.complexity ?? UNSET;
  const reopened = Number(facts.reopenCount) || 0;
  const parts: RankPart[] = [
    {
      name: 'priority',
      said: String(facts.priority ?? 'none'),
      points: pointsOf(weights.priority, facts.priority ?? 'none'),
    },
    {
      name: 'kind',
      said: String(facts.category ?? 'feature'),
      points: pointsOf(weights.kind, facts.category ?? 'feature'),
    },
    {
      name: 'complexity',
      said: complexity === UNSET ? `${UNSET} (none on the tracker)` : complexity,
      points: pointsOf(weights.complexity, complexity, weights.complexity[UNSET] ?? 0),
    },
    { name: 'module', said: moduleTerm.said, points: moduleTerm.points },
    { name: 'reopened', said: `${reopened}`, points: reopened ? weights.reopened : 0 },
    { name: 'blocks', said: `${chainCount} chained`, points: chainCount * weights.blocks },
  ];
  return { total: parts.reduce((sum, one) => sum + one.points, 0), parts };
}

/** Whole days since the issue was filed, never negative: a clock behind the filing date is no age. */
export function ageInDays(createdAt: Date, now: Date): number {
  const filed = createdAt.getTime();
  if (!Number.isFinite(filed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - filed) / DAY_MS));
}

export function ageTermOf(days: number, weights: RankWeights): RankPart {
  const ceiling = weights.ageCap === null ? Number.POSITIVE_INFINITY : weights.ageCap;
  return { name: 'age', said: `${days}d`, points: Math.min(days * weights.agePerDay, ceiling) };
}

/** The stored parts with the age term in the place `forge next` prints it, after the module term. */
export function withAge(stored: RankPart[], age: RankPart): RankPart[] {
  const at = stored.findIndex((one) => one.name === 'module');
  return [...stored.slice(0, at + 1), age, ...stored.slice(at + 1)];
}
