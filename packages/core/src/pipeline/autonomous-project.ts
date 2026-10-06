import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { isAutonomous } from './autonomous-mode.js';
import type { PipelineConfig } from './pipeline-config-schema.js';
import { readStoredPipelineConfig } from './stored-pipeline-config.js';

export async function readPipelineConfig(
  projectId: string,
  executor: Pick<Db, 'select'> = db,
): Promise<PipelineConfig | null> {
  const [row] = await executor
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = (row.agentConfig ?? {}) as { pipelineConfig?: unknown };
  return readStoredPipelineConfig(projectId, ac.pipelineConfig);
}

export async function isAutonomousProject(projectId: string): Promise<boolean> {
  return isAutonomous(await readPipelineConfig(projectId));
}
