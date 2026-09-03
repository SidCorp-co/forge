// Asking the database which driver a project runs.
//
// `autonomous-mode.ts` answers the same question about a config OBJECT and is
// deliberately import-free, so every caller that starts from a projectId had to
// write the same `select agent_config` and the same `safeParse` by hand. Four
// did, in four modules that must agree — the close gate, the park rewrite, the
// answer resume and the decompose cascade all change behaviour on this one
// boolean, and a fifth copy is how they would start disagreeing.
//
// `readPipelineConfig` rather than `loadProjectPipelineConfig`: the release
// path already owns a function by that name (`release-batch/project-config.ts`)
// whose failure answer is `PIPELINE_CONFIG_DEFAULTS`, not `null`. Two loaders
// that disagree about the unreadable case must not also share a name.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { isAutonomous } from './autonomous-mode.js';
import { type PipelineConfig, pipelineConfigSchema } from './pipeline-config-schema.js';

/** `null` when the project is missing or its stored config does not parse. */
export async function readPipelineConfig(projectId: string): Promise<PipelineConfig | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = (row.agentConfig ?? {}) as { pipelineConfig?: unknown };
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  return parsed.success ? parsed.data : null;
}

// cm:guard an unreadable config answers `false`, and since ISS-897 left one lane that is the WHOLE question this asks — `null` means the project is missing or its stored config did not parse, never that it chose something else. Answering `true` there would rewrite parks and cascade children on a project nobody can see is broken.
export async function isAutonomousProject(projectId: string): Promise<boolean> {
  return isAutonomous(await readPipelineConfig(projectId));
}
