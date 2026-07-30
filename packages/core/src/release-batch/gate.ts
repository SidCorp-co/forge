// ISS-764 — resolveReleaseGateStatus: returns the status that issues must be at
// before they can participate in a batch release, or null when the project does
// not park before release (so the batch action is meaningless / hidden).

import type { IssueStatus } from '../db/schema.js';
import type { PipelineConfig } from '../pipeline/pipeline-config-schema.js';

/**
 * Returns the gate status (`'tested'`) when the project has a real manual park
 * before release, or `null` when the tested state is disabled (no gate).
 *
 * The caller 409s with `NO_RELEASE_GATE` when this returns null; the UI hides
 * the Batch Release action for that project.
 */
export function resolveReleaseGateStatus(cfg: PipelineConfig | null): IssueStatus | null {
  const testedCfg = cfg?.states?.tested;
  // Default config has tested enabled + manual (pipeline-config-schema.ts:291-303).
  // Explicitly disabled → project sends issues straight to released without parking.
  if (testedCfg?.enabled === false) return null;
  // mode defaults to 'manual' when not set; 'auto' means the pipeline advances
  // automatically and there is no human gate to batch-release through.
  if (testedCfg?.mode === 'auto') return null;
  return 'tested';
}
