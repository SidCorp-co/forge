import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { releasesAutomatically } from './autonomous-mode.js';
import { pipelineConfigSchema } from './pipeline-config-schema.js';

/**
 * Whether this project's release is taken without a person acting — ISS-1189.
 *
 * The declaration is `states.awaiting_release.mode`, and absent is `manual`: the issue stops at
 * the rung and waits for somebody. Before this existed the sweep read
 * `pipelineConfig.autoProdDeploy` for the same answer, which is a different question — whether a
 * live-reaching deploy skips its human-confirm gate — and `release-coolify.ts` still owns that one.
 *
 * Best-effort in the same direction the confirm gate fails: a read that cannot be made answers
 * `false`, which leaves the issue standing for a person rather than releasing on a guess.
 */
export async function projectReleasesAutomatically(projectId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? null) as { pipelineConfig?: unknown } | null;
    if (!ac?.pipelineConfig) return false;
    const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig);
    return parsed.success && releasesAutomatically(parsed.data);
  } catch (err) {
    logger.warn(
      { err, projectId },
      'auto-release: could not read the release declaration — leaving the issue for a person',
    );
    return false;
  }
}
