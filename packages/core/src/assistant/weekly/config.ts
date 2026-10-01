import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { PipelineConfigUnreadable } from '../../pipeline/pipeline-config-unreadable.js';
import { readableStoredPipelineConfig } from '../../pipeline/stored-pipeline-config.js';

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
export function readAssistantWeekly(
  projectId: string,
  agentConfig: unknown,
): AssistantWeeklyConfig | null {
  const ac = (agentConfig ?? {}) as { pipelineConfig?: unknown };
  const raw = readableStoredPipelineConfig(projectId, ac.pipelineConfig).assistantWeekly as
    | (Partial<AssistantWeeklyConfig> & { enabled?: unknown })
    | undefined;
  if (raw?.enabled !== true) return null;
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
  return readAssistantWeekly(projectId, row?.agentConfig);
}

/**
 * Every project whose config is on, with what the reading needs of it. A project whose stored
 * pipelineConfig is refused is logged and handed to `refused`, and the others are still read.
 */
export async function listOptedInProjects(
  dbi: Executor = db,
  refused: Array<{ projectId: string; message: string }> = [],
): Promise<OptedInProject[]> {
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
    let config: AssistantWeeklyConfig | null;
    try {
      config = readAssistantWeekly(row.projectId, row.agentConfig);
    } catch (err) {
      if (!(err instanceof PipelineConfigUnreadable)) throw err;
      logger.error({ projectId: row.projectId, refused: err.refused }, err.message);
      refused.push({ projectId: row.projectId, message: err.message });
      continue;
    }
    if (config && row.createdBy)
      out.push({ projectId: row.projectId, slug: row.slug, createdBy: row.createdBy, config });
  }
  return out;
}
