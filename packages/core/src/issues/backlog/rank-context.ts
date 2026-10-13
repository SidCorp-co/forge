/**
 * What a ranking is scored under for one project (ISS-1336): its stored weight overrides folded
 * over the built-in table, the modules it defines, and the refusal where the two disagree.
 */

import { sql } from 'drizzle-orm';
import { type IndexExecutor, rowsOf } from './index-sql.js';
import {
  foldRankWeights,
  type ModuleDefinition,
  type RankWeights,
  RankWeightsRefused,
  scoringWeightsHash,
  undefinedModuleKeys,
  undefinedModuleSentence,
} from './rank-weights.js';

export interface RankContext {
  weights: RankWeights;
  from: 'built-in' | 'project';
  moduleTable: Record<string, number> | null;
  modules: ModuleDefinition[];
  /** The hash a score is stored under; stable while no scoring weight moves. */
  hash: string;
  /** Set where the stored table cannot be ranked by: no ordering is served, and none is stored. */
  refusal: string | null;
}

async function projectModules(
  executor: IndexExecutor,
  projectId: string,
): Promise<ModuleDefinition[]> {
  const rows = await rowsOf(
    executor,
    sql`SELECT id::text AS id, name, parent_id::text AS parent_id
          FROM labels WHERE project_id = ${projectId}::uuid AND kind = 'module'`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    parentId: row.parent_id ? String(row.parent_id) : null,
  }));
}

export async function loadRankContext(
  executor: IndexExecutor,
  projectId: string,
): Promise<RankContext> {
  const [row] = await rowsOf(
    executor,
    sql`SELECT agent_config #> '{pipelineConfig,rank}' AS rank FROM projects WHERE id = ${projectId}::uuid`,
  );
  const stored = row?.rank ?? null;
  const asked = typeof stored === 'string' ? JSON.parse(stored) : stored;
  try {
    const folded = foldRankWeights(asked);
    const modules = await projectModules(executor, projectId);
    const unknown = folded.moduleTable ? undefinedModuleKeys(folded.moduleTable, modules) : [];
    return {
      weights: folded.value,
      from: folded.from,
      moduleTable: folded.moduleTable,
      modules,
      hash: scoringWeightsHash(folded.value, folded.moduleTable),
      refusal: unknown.length ? undefinedModuleSentence(unknown, modules) : null,
    };
  } catch (error) {
    if (!(error instanceof RankWeightsRefused)) throw error;
    const folded = foldRankWeights(null);
    return {
      weights: folded.value,
      from: 'project',
      moduleTable: null,
      modules: [],
      hash: 'refused',
      refusal: error.message,
    };
  }
}
