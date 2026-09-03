// The pipeline-config read the release path needs; branches come from
// `projects/service.ts:readProjectBranches` like every other surface.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  pipelineConfigSchema,
} from '../pipeline/pipeline-config-schema.js';

export async function loadProjectPipelineConfig(projectId: string): Promise<PipelineConfig | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = (row.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  if (!parsed.success) return { ...PIPELINE_CONFIG_DEFAULTS };
  return parsed.data;
}
