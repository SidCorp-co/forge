import { hooks } from '../pipeline/hooks.js';

/**
 * ISS-1072 — the OTHER door onto the contract's inputs.
 *
 * `baseBranch`, `liveBranch` and `releaseModel` are read by
 * `work-evidence.ts:collectWorkEvidence`, so moving any of them moves the
 * `work_evidence` criterion's answer for every issue on the project.
 *
 * Announced on the patch NAMING the field rather than on the value moving, which
 * is the rule the pipeline-config service already keeps.
 *
 * ISS-1070 — the `agentConfig` branch is gone with the door it announced. This route took a
 * wide-open `agentConfig` jsonb, so `statusEntryCriteria` could be replaced here without
 * `updatePipelineConfig` running at all; it no longer takes one, and that service is now the only
 * writer of `pipelineConfig` and already announces the change itself.
 */
// cm:guard fired AFTER the transaction returned, and never inside it: a subscriber of this reaches
// GitHub over the network, and running it inside would hold the project's row lock across an HTTP
// call and roll a committed settings write back on a GitHub outage.
export async function announceContractInput(
  projectId: string,
  patch: {
    baseBranch?: unknown;
    liveBranch?: unknown;
    releaseModel?: unknown;
  },
): Promise<void> {
  const moved: string[] = [];
  for (const field of ['baseBranch', 'liveBranch', 'releaseModel'] as const) {
    if (patch[field] !== undefined) moved.push(field);
  }
  if (moved.length === 0) return;
  await hooks.emit('contractInputChanged', {
    projectId,
    reason: `project settings written: ${moved.join(', ')}`,
  });
}
