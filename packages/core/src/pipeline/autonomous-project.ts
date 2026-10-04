import { isAutonomous } from './autonomous-mode.js';
import { readEffectivePolicy } from './ports.js';

export async function isAutonomousProject(projectId: string): Promise<boolean> {
  const held = await readEffectivePolicy(projectId);
  return isAutonomous(held?.document ?? null);
}
