// The two project reads the release path needs, in one place so the service and
// its read-only twin do not each grow a copy.

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

export async function loadProjectBranchConfig(
  projectId: string,
): Promise<{ baseBranch: string; productionBranch: string } | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
  const bc = (ac.branchConfig as Record<string, unknown> | undefined) ?? {};
  return {
    baseBranch: (bc.baseBranch as string | undefined) ?? 'main',
    productionBranch: (bc.productionBranch as string | undefined) ?? 'main',
  };
}
