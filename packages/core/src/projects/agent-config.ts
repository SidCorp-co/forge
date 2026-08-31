import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

/**
 * Shared helpers for the `projects.agentConfig` jsonb blob.
 *
 * Several settings surfaces (stateContext, personaStyle, pipeline-config,
 * project-facts, skills bootstrap) each need the same read-modify-write dance:
 * read the whole blob, touch only their own sub-key(s), write the whole blob
 * back — Postgres's `jsonb || jsonb` shallow merge is deliberately avoided so
 * a scoped patch can never wipe sibling keys. These helpers centralise that
 * dance; each caller keeps its own merge semantics in the mutate step.
 */
export type AgentConfig = Record<string, unknown>;

/**
 * Read a project's agentConfig. Returns `null` when the project row does not
 * exist (callers that must 404 check for it), and `{}` when the row exists but
 * the column is null.
 */
export async function readAgentConfig(projectId: string): Promise<AgentConfig | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return (row.agentConfig ?? {}) as AgentConfig;
}

/** Overwrite a project's agentConfig blob wholesale. */
export async function writeAgentConfig(projectId: string, agentConfig: AgentConfig): Promise<void> {
  await db.update(projects).set({ agentConfig }).where(eq(projects.id, projectId));
}

/**
 * Atomic-ish read-modify-write: read the blob, apply `mutate` to a shallow
 * copy, write the result back. Returns the merged blob, or `null` (no write)
 * when the project does not exist.
 */
export async function mergeAgentConfig(
  projectId: string,
  mutate: (current: AgentConfig) => AgentConfig,
): Promise<AgentConfig | null> {
  const current = await readAgentConfig(projectId);
  if (current === null) return null;
  const merged = mutate({ ...current });
  await writeAgentConfig(projectId, merged);
  return merged;
}

// cm:guard the key is DELETED when `mutate` answers null, never written as `key: null`. Every reader here treats an absent key and a null one differently — `stateContext` null means "no override", a null-valued key means "an override that is null" — and the four settings surfaces that used to inline this dance each got that right by hand, which is exactly the arrangement that stops being true on the fifth.
export async function patchAgentConfigKey(
  projectId: string,
  key: string,
  mutate: (current: AgentConfig) => unknown,
): Promise<void> {
  const merged = await mergeAgentConfig(projectId, (current) => {
    const next = mutate(current);
    if (next === null) {
      return Object.fromEntries(Object.entries(current).filter(([k]) => k !== key));
    }
    return { ...current, [key]: next };
  });
  if (merged === null) throw new Error('NOT_FOUND: project not found');
}
