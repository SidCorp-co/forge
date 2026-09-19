import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { AGENT_CONFIG_KEYS, type AgentConfigKey } from './agent-config-schema.js';

export type AgentConfig = Record<string, unknown>;

/** A drizzle handle: the pooled client, or a transaction a route is already inside. */
type Db = Pick<typeof db, 'select' | 'execute'>;

/**
 * Read a project's agentConfig. Returns `null` when the project row does not
 * exist (callers that must 404 check for it), and `{}` when the row exists but
 * the column is null.
 */
export async function readAgentConfig(projectId: string, tx: Db = db): Promise<AgentConfig | null> {
  const [row] = await tx
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return (row.agentConfig ?? {}) as AgentConfig;
}

const DECLARED = new Set<string>(AGENT_CONFIG_KEYS);

/** One declared key's next value: `null` DELETES the key, anything else stores it. */
export type AgentConfigKeyPatch = Partial<Record<AgentConfigKey, unknown>>;

export async function patchAgentConfigKeys(
  projectId: string,
  patch: AgentConfigKeyPatch,
  tx: Db = db,
): Promise<void> {
  const entries = Object.entries(patch) as Array<[AgentConfigKey, unknown]>;
  if (entries.length === 0) return;

  const undeclared = entries.map(([key]) => key).filter((key) => !DECLARED.has(key));
  if (undeclared.length > 0) {
    throw new Error(
      `agentConfig has no declared key named ${undeclared.join(', ')} — declare it in agent-config-schema.ts and give it a door, or do not write it. Declared: ${AGENT_CONFIG_KEYS.join(', ')}.`,
    );
  }

  const removed = JSON.stringify(entries.filter(([, value]) => value === null).map(([key]) => key));
  const additions = JSON.stringify(Object.fromEntries(entries.filter(([, v]) => v !== null)));

  await tx.execute(
    sql`UPDATE projects
           SET agent_config =
             (COALESCE(agent_config, '{}'::jsonb)
                - ARRAY(SELECT jsonb_array_elements_text(${removed}::jsonb)))
             || ${additions}::jsonb
         WHERE id = ${projectId}`,
  );
}

export const RETIRED_STATE_CONTEXT_MESSAGE =
  'agentConfig.stateContext decides nothing and has been removed — a model override and a spend cap per jobType were stored there and consulted by no dispatch. The per-stage keys that DO decide are pipelineConfig.states[*].model and pipelineConfig.states[*].budget, resolved by resolveStageOverrides and enforced by jobs/budget-check.ts. Set those instead, and remove stateContext from this request.';
