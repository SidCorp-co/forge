import { hooks } from '../pipeline/hooks.js';

/**
 * ISS-1072 — the OTHER door onto the contract's inputs.
 *
 * `pipeline-config-service.ts` announces a declaration change made through the
 * dedicated pipeline-config route. This route takes a wide-open `agentConfig`
 * jsonb, so `statusEntryCriteria` can be replaced here without that service
 * running at all — and `baseBranch`, `liveBranch` and `releaseModel` are read by
 * `work-evidence.ts:collectWorkEvidence`, so moving any of them moves the
 * `work_evidence` criterion's answer for every issue on the project.
 *
 * Announced on the patch NAMING the field rather than on the value moving, which
 * is the rule the pipeline-config service already keeps: `agentConfig` is written
 * wholesale here, so a patch carrying it may have added or removed the
 * declaration and the only honest reading is that it may have.
 */
// cm:guard fired AFTER the transaction returned, and never inside it: a subscriber of this reaches
// GitHub over the network, and running it inside would hold the project's row lock across an HTTP
// call and roll a committed settings write back on a GitHub outage.
export async function announceContractInput(
  projectId: string,
  patch: {
    agentConfig?: unknown;
    baseBranch?: unknown;
    liveBranch?: unknown;
    releaseModel?: unknown;
  },
): Promise<void> {
  const moved: string[] = [];
  if (patch.agentConfig !== undefined) moved.push('agentConfig (may carry statusEntryCriteria)');
  for (const field of ['baseBranch', 'liveBranch', 'releaseModel'] as const) {
    if (patch[field] !== undefined) moved.push(field);
  }
  if (moved.length === 0) return;
  await hooks.emit('contractInputChanged', {
    projectId,
    reason: `project settings written: ${moved.join(', ')}`,
  });
}
