// The failure-cause vocabulary is `@forge/contracts/failure-causes`; core adds where each cause
// comes from.
import type { FailureCause } from '@forge/contracts/failure-causes';

export {
  FAILURE_CAUSE_PRESENTATION,
  FAILURE_CAUSES,
  type FailureCause,
  type FailureCausePresentation,
  LEGACY_CAUSE_ALIAS,
  LEGACY_NEUTRAL_REASONS,
  resolveFailureCause,
} from '@forge/contracts/failure-causes';

type FailureOrigin =
  | 'provider'
  | 'agent'
  | 'workspace'
  | 'transport'
  | 'forge'
  | 'lifecycle'
  | 'user'
  | 'unknown';

export const FAILURE_CAUSE_ORIGIN: Record<FailureCause, FailureOrigin> = {
  provider_spend_cap: 'provider',
  provider_usage_limit: 'provider',
  provider_subscription_disabled: 'provider',
  provider_auth_expired: 'provider',
  provider_overloaded: 'provider',
  provider_refused_request: 'provider',
  agent_startup_failed: 'agent',
  agent_skill_missing: 'agent',
  agent_exited_without_result: 'agent',
  agent_killed: 'agent',
  skill_not_synced: 'agent',
  workspace_preflight_failed: 'workspace',
  workspace_disk_full: 'workspace',
  repo_root_contention: 'workspace',
  box_session_saturated: 'forge',
  runner_unreachable: 'transport',
  duplex_channel_failed: 'transport',
  session_lost: 'transport',
  heartbeat_timeout: 'transport',
  queue_timeout: 'transport',
  turn_never_reported: 'transport',
  no_client_ack: 'transport',
  ws_publish_failed: 'transport',
  forge_budget_exhausted: 'forge',
  runner_unsupported_type: 'forge',
  resume_failed: 'forge',
  residency_expired: 'forge',
  park_unanswered: 'user',
  audit_ran_blind: 'forge',
  session_authority_refused: 'user',
  orphan_under_terminal_run: 'lifecycle',
  pipeline_cancelled: 'lifecycle',
  pipeline_completed: 'lifecycle',
  pipeline_failed: 'lifecycle',
  migration_zombie_cleanup: 'lifecycle',
  manual_ops_stale_chat_schedule: 'lifecycle',
  user_cancelled: 'user',
  unclassified: 'unknown',
};

export function isRealFailureCause(cause: FailureCause): boolean {
  const origin = FAILURE_CAUSE_ORIGIN[cause];
  return origin !== 'lifecycle' && origin !== 'user';
}
