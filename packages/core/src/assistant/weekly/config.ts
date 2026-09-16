/**
 * ISS-1056 — who opted in: `pipelineConfig.assistantWeekly` on the project's `agentConfig`,
 * declared in `pipeline/pipeline-config-schema.ts` and written through `updatePipelineConfig`
 * only. Absent means OFF, as `knowledgePromotion` does, so a cron nobody watches never reads a
 * project that did not ask for it.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';

export interface AssistantWeeklyConfig {
  /** The issue key the week-over-week series is posted on, e.g. `ISS-1060`. */
  pinnedIssue: string;
  /** A provider id the app registered (`providers/registry.ts`); the judge's credential. */
  judgeProviderId: string;
  judgeModel: string;
  /** One door only, when set (`chat_logs.source`). */
  source?: string;
}

export interface OptedInProject {
  projectId: string;
  slug: string;
  createdBy: string;
  config: AssistantWeeklyConfig;
}

type Executor = Pick<typeof db, 'select'>;

/** The config under `agentConfig.pipelineConfig.assistantWeekly`, null unless `enabled` is true. */
export function readAssistantWeekly(agentConfig: unknown): AssistantWeeklyConfig | null {
  const ac = (agentConfig ?? {}) as { pipelineConfig?: { assistantWeekly?: unknown } };
  const raw = ac.pipelineConfig?.assistantWeekly as
    | (Partial<AssistantWeeklyConfig> & { enabled?: unknown })
    | undefined;
  if (!raw || raw.enabled !== true) return null;
  if (!raw.pinnedIssue || !raw.judgeProviderId || !raw.judgeModel) return null;
  return {
    pinnedIssue: raw.pinnedIssue,
    judgeProviderId: raw.judgeProviderId,
    judgeModel: raw.judgeModel,
    ...(raw.source ? { source: raw.source } : {}),
  };
}

export async function resolveAssistantWeekly(
  projectId: string,
  dbi: Executor = db,
): Promise<AssistantWeeklyConfig | null> {
  const [row] = await dbi
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return readAssistantWeekly(row?.agentConfig);
}

/** Every project whose config is on, with what the reading needs of it. */
export async function listOptedInProjects(dbi: Executor = db): Promise<OptedInProject[]> {
  const rows = await dbi
    .select({
      projectId: projects.id,
      slug: projects.slug,
      createdBy: projects.createdBy,
      agentConfig: projects.agentConfig,
    })
    .from(projects);
  const out: OptedInProject[] = [];
  for (const row of rows) {
    const config = readAssistantWeekly(row.agentConfig);
    if (config && row.createdBy)
      out.push({ projectId: row.projectId, slug: row.slug, createdBy: row.createdBy, config });
  }
  return out;
}
