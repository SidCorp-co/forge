/**
 * The weight table a backlog ordering is scored against, and the one place a project overrides it
 * (ISS-1336). The table lives in the project's pipeline config under `rank`, where the server can
 * see it, so a ranking made here never drops an override it could not read.
 *
 * Every number below is the CLI's own (`plugin/src/rank/weights.mjs`), moved here unchanged:
 * what a weight means is `docs/cli/next-weights.md`'s in forge-plugin, and nothing here decides it.
 */

import { createHash } from 'node:crypto';
import { issueComplexities, issuePriorities } from '../../db/issue-vocabulary.js';

export const UNSET = 'unset';

/** The kinds an issue is filed as, which `issues.category` carries; one with no row scores 0. */
export const RANK_KINDS = ['bug', 'enhancement', 'feature', 'review'] as const;

export interface RankWeights {
  priority: Record<string, number>;
  kind: Record<string, number>;
  complexity: Record<string, number>;
  /** Keyed by the modules the project defines; one with no row takes its parent's, then `unset`. */
  module: Record<string, number>;
  agePerDay: number;
  ageCap: number | null;
  reopened: number;
  blocks: number;
  /** Spent by the client, which reads it off one checkout's review mark; carried so a project has one home for its table. */
  reading: number;
  /** The floor a search hit reads back as related at; batch formation is the client's. */
  similarity: number;
  batchCap: number;
}

export const BUILT_IN_RANK_WEIGHTS: RankWeights = {
  priority: { critical: 40, high: 30, medium: 20, low: 10, none: 0 },
  kind: { bug: 8, enhancement: 4, review: 2, feature: 0 },
  complexity: { xs: 8, s: 6, m: 4, l: 2, xl: 1, [UNSET]: 0 },
  module: { [UNSET]: 0 },
  agePerDay: 1,
  ageCap: null,
  reopened: 5,
  blocks: 3,
  reading: 60,
  similarity: 0.78,
  batchCap: 3,
};

const TABLES = ['priority', 'kind', 'complexity', 'module'] as const;
type TableName = (typeof TABLES)[number];

/** The rows each table may name; `module` takes any name, judged against the project's modules at ranking time. */
const TABLE_ROWS: Record<Exclude<TableName, 'module'>, readonly string[]> = {
  priority: issuePriorities,
  kind: RANK_KINDS,
  complexity: [...issueComplexities, UNSET],
};

const SCALARS = [
  'agePerDay',
  'ageCap',
  'reopened',
  'blocks',
  'reading',
  'similarity',
  'batchCap',
] as const;

/** Keys that bounded the CLI's per-call loop; the ordering is read from an index with no such bound. */
export const RETIRED_RANK_KEYS: Record<string, string> = {
  windowCap:
    '`rank.windowCap` retired with ISS-1336: it was how many bodies one `forge next` pass read, and the ordering is now read from a maintained index that reads no bodies. Remove it.',
  readCap:
    '`rank.readCap` retired with ISS-1336: it was where the `forge next` read loop gave up, and the ordering is now read from a maintained index that has no such bound. Remove it.',
};

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `null` where `given` is a legal `rank` object, otherwise the sentence naming what is wrong and what is valid. */
export function rankWeightsProblem(given: unknown): string | null {
  if (!isRecord(given)) {
    return '`rank` is an object holding the weights you are changing, for example `{"priority":{"high":35}}`.';
  }
  const weights = [...TABLES, ...SCALARS];
  for (const [key, value] of Object.entries(given)) {
    if (Object.hasOwn(RETIRED_RANK_KEYS, key)) return RETIRED_RANK_KEYS[key] as string;
    if (!weights.includes(key as never)) {
      return `\`rank.${key}\` is no weight of this table. It holds: ${weights.join(', ')}.`;
    }
    if ((TABLES as readonly string[]).includes(key)) {
      const table = key as TableName;
      if (!isRecord(value)) {
        const rows = table === 'module' ? 'module names' : TABLE_ROWS[table].join(', ');
        return `\`rank.${key}\` is a table of ${rows}, not a single value.`;
      }
      for (const [name, held] of Object.entries(value)) {
        if (table !== 'module' && !TABLE_ROWS[table].includes(name)) {
          return `\`rank.${key}.${name}\` names no row of that table. It holds: ${TABLE_ROWS[table].join(', ')}.`;
        }
        if (!isNumber(held)) {
          return `\`rank.${key}.${name}\` is a number of points, not \`${JSON.stringify(held)}\`.`;
        }
      }
      continue;
    }
    if (isNumber(value) || (key === 'ageCap' && value === null)) continue;
    return key === 'ageCap'
      ? `\`rank.ageCap\` is a number of points or \`null\` for no ceiling, not \`${JSON.stringify(value)}\`.`
      : `\`rank.${key}\` is a number, not \`${JSON.stringify(value)}\`.`;
  }
  return null;
}

export interface FoldedRankWeights {
  value: RankWeights;
  /** Whether the project stored any override. */
  from: 'built-in' | 'project';
  /** The project's own `rank.module` table, or null where it set none: no table weighs no module. */
  moduleTable: Record<string, number> | null;
}

/** The built-in table with a project's `rank` object folded over it, one weight at a time. Throws on a table that names something this one does not, which the write door already refuses. */
export function foldRankWeights(given: unknown): FoldedRankWeights {
  if (given === undefined || given === null) {
    return { value: BUILT_IN_RANK_WEIGHTS, from: 'built-in', moduleTable: null };
  }
  const problem = rankWeightsProblem(given);
  if (problem) throw new RankWeightsRefused(problem);
  const asked = given as Record<string, unknown>;
  const value: RankWeights = { ...BUILT_IN_RANK_WEIGHTS };
  for (const key of SCALARS) {
    if (Object.hasOwn(asked, key)) (value as unknown as Record<string, unknown>)[key] = asked[key];
  }
  for (const table of TABLES) {
    value[table] = {
      ...BUILT_IN_RANK_WEIGHTS[table],
      ...((asked[table] as object | undefined) ?? {}),
    };
  }
  const own = asked.module as Record<string, number> | undefined;
  return { value, from: 'project', moduleTable: own ? { ...own } : null };
}

export class RankWeightsRefused extends Error {
  readonly code = 'RANK_WEIGHTS_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'RankWeightsRefused';
  }
}

/** What a stored score depends on: age, `reading`, `similarity` and `batchCap` are not in it, so changing one does not rescore a row. */
export function scoringWeightsHash(
  weights: RankWeights,
  moduleTable: Record<string, number> | null,
): string {
  const scored = {
    priority: sorted(weights.priority),
    kind: sorted(weights.kind),
    complexity: sorted(weights.complexity),
    module: moduleTable === null ? null : sorted(moduleTable),
    reopened: weights.reopened,
    blocks: weights.blocks,
  };
  return createHash('sha256').update(JSON.stringify(scored)).digest('hex').slice(0, 24);
}

function sorted(table: Record<string, number>): Array<[string, number]> {
  return Object.entries(table).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface ModuleDefinition {
  id: string;
  name: string;
  parentId: string | null;
}

/** Each `rank.module` key naming no module the project defines, the `unset` row excepted. */
export function undefinedModuleKeys(
  table: Record<string, number>,
  modules: ModuleDefinition[],
): string[] {
  const names = new Set(modules.map((one) => one.name));
  return Object.keys(table).filter((key) => key !== UNSET && !names.has(key));
}

export function undefinedModuleSentence(keys: string[], modules: ModuleDefinition[]): string {
  const defined = modules.length
    ? `This project defines: ${modules.map((one) => one.name).join(', ')}.`
    : 'This project defines no module yet.';
  return (
    `\`rank.module\` weighs ${keys.map((one) => `\`${one}\``).join(', ')}, which ` +
    `${keys.length === 1 ? 'is no module' : 'are no modules'} this project defines, so the ranking would score ` +
    `nothing by ${keys.length === 1 ? 'it' : 'them'} and say nothing about it. ${defined} ` +
    "Rename or drop the key in this project's pipeline config, or define the module."
  );
}

/** The module, its parent, its parent's parent, and so on to the top; the walk ends at the first one met twice. */
function lineOf(module: ModuleDefinition, modules: ModuleDefinition[]): ModuleDefinition[] {
  const byId = new Map(modules.map((one) => [one.id, one]));
  const line: ModuleDefinition[] = [];
  const seen = new Set<string>();
  for (let at: ModuleDefinition | undefined = module; at && !seen.has(at.id); ) {
    seen.add(at.id);
    line.push(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return line;
}

/** What a module scores under the table: its own row, else the nearest ancestor's, else `unset`. */
export function moduleWeightOf(
  module: ModuleDefinition | null,
  modules: ModuleDefinition[],
  table: Record<string, number>,
): { points: number; row: string; via: string | null } {
  if (module) {
    for (const [depth, one] of lineOf(module, modules).entries()) {
      if (one.name !== UNSET && Object.hasOwn(table, one.name)) {
        return { points: table[one.name] as number, row: one.name, via: depth ? one.name : null };
      }
    }
  }
  return { points: table[UNSET] ?? 0, row: UNSET, via: null };
}
