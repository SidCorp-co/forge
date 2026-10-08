import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';

/** The declaration itself, and a failed read is the caller's to name: it throws. */
export async function readAutoProdDeploy(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? null) as Record<string, unknown> | null;
  const pc = ac?.pipelineConfig as Record<string, unknown> | undefined;
  return pc?.autoProdDeploy === true;
}

/** Whether a release here is taken without a person confirming it, which makes
 *  `release-sweep.ts` the only thing that cuts it. A failed read keeps the gate on. */
export async function projectAutoProdDeploy(projectId: string): Promise<boolean> {
  try {
    return await readAutoProdDeploy(projectId);
  } catch (err) {
    logger.warn({ err, projectId }, 'coolify: failed to read autoProdDeploy — keeping prod gate');
    return false;
  }
}
