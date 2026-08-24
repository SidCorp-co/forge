// ISS-764 — resolveReleaseGateStatus: returns the status that issues must be at
// before they can participate in a batch release, or null when the project does
// not park before release (so the batch action is meaningless / hidden).

import type { IssueStatus } from '../db/schema.js';
import { isAutonomous } from '../pipeline/autonomous-mode.js';
import type { PipelineConfig } from '../pipeline/pipeline-config-schema.js';

/**
 * Returns the gate status (`'tested'`) when the project has a real manual park
 * before release, or `null` when the tested state is disabled (no gate).
 *
 * The caller 409s with `NO_RELEASE_GATE` when this returns null; the UI hides
 * the Batch Release action for that project.
 */
// cm:guard on an AUTONOMOUS project the gate must be declared, never defaulted. A staged issue walks to `tested` on its own and a default gate costs nothing; an autonomous agent is BLOCKED from closing by this answer (issues/release-gate-hold.ts), so defaulting one on would park every issue of every project that never asked for a release path, with nothing configured to release them.
export function resolveReleaseGateStatus(cfg: PipelineConfig | null): IssueStatus | null {
  const testedCfg = cfg?.states?.tested;
  if (testedCfg?.enabled === false) return null;
  if (testedCfg?.mode === 'auto') return null;
  if (isAutonomous(cfg)) return testedCfg?.mode === 'manual' ? 'tested' : null;
  return 'tested';
}
