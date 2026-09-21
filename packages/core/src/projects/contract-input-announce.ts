import { hooks } from '../pipeline/hooks.js';

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
