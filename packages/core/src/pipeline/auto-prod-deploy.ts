import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';

/** Whether a release here is taken without a person confirming it, which makes
 *  `release-sweep.ts` the only thing that cuts it. A failed read keeps the gate on. */
export async function projectAutoProdDeploy(projectId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? null) as Record<string, unknown> | null;
    const pc = ac?.pipelineConfig as Record<string, unknown> | undefined;
    return pc?.autoProdDeploy === true;
  } catch (err) {
    logger.warn({ err, projectId }, 'coolify: failed to read autoProdDeploy — keeping prod gate');
    return false;
  }
}
