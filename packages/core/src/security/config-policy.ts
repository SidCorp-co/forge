import type { StageConfig } from '../pipeline/pipeline-config-schema.js';
import type { Finding } from './findings.js';

/**
 * Validate a single pipeline stage config against established policy rules.
 * All findings are `warn` severity — this never blocks dispatch.
 *
 * @param stageStatus - The issue status key for this stage (e.g. 'approved').
 * @param stage - The resolved StageConfig for this status.
 * @param defaultModel - The DEFAULT_STAGE_MODELS entry for this status, or null
 *   if the status has no default. Passed in to avoid a circular import between
 *   security/ and jobs/.
 */
export function validateStagePolicy(
  stageStatus: string,
  stage: StageConfig,
  defaultModel: string | null,
): Finding[] {
  const findings: Finding[] = [];

  // R5 (ISS-531): bypassPermissions without a non-empty denylist.
  if (stage.permissionMode === 'bypassPermissions') {
    const denylist = stage.disallowedTools;
    if (!denylist || denylist.length === 0) {
      findings.push({
        severity: 'warn',
        rule: 'policy.bypass-no-denylist',
        field: `states.${stageStatus}.disallowedTools`,
        message:
          'Stage uses bypassPermissions but has no disallowedTools denylist (ISS-531 policy)',
        excerpt: `states.${stageStatus}.permissionMode = bypassPermissions`,
      });
    }
  }

  // R6 (ISS-535): no model set AND status not in the default-model table.
  if (!stage.model && defaultModel === null) {
    findings.push({
      severity: 'warn',
      rule: 'policy.no-model',
      field: `states.${stageStatus}.model`,
      message: `Stage has no model and status '${stageStatus}' is not in the default model table (ISS-535 policy)`,
      excerpt: `states.${stageStatus}.model = (unset)`,
    });
  }

  // R7: allowedTools broader than 50 entries.
  if (stage.allowedTools && stage.allowedTools.length > 50) {
    findings.push({
      severity: 'warn',
      rule: 'policy.broad-allowlist',
      field: `states.${stageStatus}.allowedTools`,
      message: `Stage has ${stage.allowedTools.length} allowedTools entries (>50 is an over-broad allowlist signal)`,
      excerpt: `states.${stageStatus}.allowedTools.length = ${stage.allowedTools.length}`,
    });
  }

  return findings;
}
