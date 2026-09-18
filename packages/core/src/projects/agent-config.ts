import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { AGENT_CONFIG_KEYS, type AgentConfigKey } from './agent-config-schema.js';

/**
 * The read and write helpers for the `projects.agentConfig` jsonb blob.
 *
 * ISS-1070 — every write here is ONE statement against ONE named key. What it replaced was a
 * read-modify-write of the whole document: three settings surfaces each read the blob, changed
 * their own sub-key and wrote the whole thing back, so a sibling key written by another request
 * between the read and the write was silently restored to its old value. That is the
 * `wholesale-config-clobber` shape, and no amount of care at the call sites removes it — the fix
 * is that the whole document is never the unit of a write.
 */
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

/**
 * Set or delete named keys of a project's agentConfig in a single statement.
 *
 * `null` deletes the key rather than storing `key: null`, because every reader in this tree treats
 * an absent key and a null one differently — an absent `personaStyle` means "no style", a
 * null-valued one means "a style that is null" (ISS-1000, the shape `patchAgentConfigKey` was
 * written for).
 *
 * Pass `tx` to run inside a caller's transaction. `PATCH /api/projects/:id` does, so a request that
 * fails on a sibling field — a conflicting `issuePrefix`, say — rolls its config write back with it
 * instead of leaving the configuration changed by a request that answered an error.
 */
// cm:guard ONE statement, and the merge happens in Postgres rather than in this process. A read-modify-write here would reintroduce exactly the lost-update this function exists to remove: the row is read at one instant and written at another, and every key the reader saw is written back over whatever happened in between.
// cm:edge contract -> packages/core/src/projects/agent-config-schema.ts — `AgentConfigKey` is that file's declared key set, so a key with no declaration cannot be written through here at all
export async function patchAgentConfigKeys(
  projectId: string,
  patch: AgentConfigKeyPatch,
  tx: Db = db,
): Promise<void> {
  const entries = Object.entries(patch) as Array<[AgentConfigKey, unknown]>;
  if (entries.length === 0) return;

  // cm:guard the key is checked against the DECLARATION at the last moment before it reaches SQL, and refused by name rather than written. Nothing in this process should reach here with an undeclared key — the routes refuse one long before — so this is the assertion that the door set and the declared set have not drifted, on the one path where a drift would write to the column.
  const undeclared = entries.map(([key]) => key).filter((key) => !DECLARED.has(key));
  if (undeclared.length > 0) {
    throw new Error(
      `agentConfig has no declared key named ${undeclared.join(', ')} — declare it in agent-config-schema.ts and give it a door, or do not write it. Declared: ${AGENT_CONFIG_KEYS.join(', ')}.`,
    );
  }

  const removed = JSON.stringify(entries.filter(([, value]) => value === null).map(([key]) => key));
  const additions = JSON.stringify(Object.fromEntries(entries.filter(([, v]) => v !== null)));

  // cm:why `- text[]` removes every named key at once and answers the document unchanged when it holds none of them, and `|| jsonb` adds the rest — both are no-ops for an empty operand, so one statement serves a pure delete, a pure set and a mix of the two
  // cm:guard the removal list travels as JSON and is turned into the array in Postgres, NOT as a JS array bound directly: drizzle renders an empty bound array as the literal `()`, which is a syntax error, so a patch that only SETS keys — the commonest one — fails at the database. `ARRAY(SELECT ...)` over an empty set is an empty array and not NULL, which `- NULL` would make the whole document.
  await tx.execute(
    sql`UPDATE projects
           SET agent_config =
             (COALESCE(agent_config, '{}'::jsonb)
                - ARRAY(SELECT jsonb_array_elements_text(${removed}::jsonb)))
             || ${additions}::jsonb
         WHERE id = ${projectId}`,
  );
}

/**
 * ISS-1000 — `agentConfig.stateContext` was a model override and a spend cap
 * per jobType, validated and persisted through three doors and read by no
 * dispatcher. It is retired, and a caller that still sends it is told so by
 * name: removing the field from the schemas alone would answer the same write
 * with a 200 and a silent drop, which is the defect the retirement is for.
 *
 * One message, because there were three doors — the scoped field on
 * `PATCH /projects/:id`, the same key inside that route's wholesale
 * `agentConfig`, and MCP `forge_config`.
 */
// cm:edge contract -> packages/core/src/jobs/stage-overrides.ts — `resolveStageOverrides` resolves the `model` and `budget` this message names; a rename there leaves this text pointing at a path that no longer exists
export const RETIRED_STATE_CONTEXT_MESSAGE =
  'agentConfig.stateContext decides nothing and has been removed — a model override and a spend cap per jobType were stored there and consulted by no dispatch. The per-stage keys that DO decide are pipelineConfig.states[*].model and pipelineConfig.states[*].budget, resolved by resolveStageOverrides and enforced by jobs/budget-check.ts. Set those instead, and remove stateContext from this request.';
