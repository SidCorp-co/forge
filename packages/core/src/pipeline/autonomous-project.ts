import { readEffectivePolicy } from '../project-config/effective.js';
import { isAutonomous } from './autonomous-mode.js';

export async function isAutonomousProject(projectId: string): Promise<boolean> {
  const held = await readEffectivePolicy(projectId);
  return isAutonomous(held?.document ?? null);
}
