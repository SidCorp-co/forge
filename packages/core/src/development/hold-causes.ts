// The cause of a hold as one plain sentence a person reads (ISS-684): every code a hold can carry
// (a failure cause, a gate or job-hold reason, a stuck rule) maps to its own sentence, so no code
// or snake_case reaches the page. The code itself rides `OverviewHold.code` for the technical view.

import type { FailureCause } from '@forge/contracts/failure-causes';
import type { RunStuckRule } from '@forge/contracts/run-standing';
import { type Said, type SaidPlainKey, say } from '@forge/contracts/said';

const FAILURE: Readonly<Record<FailureCause, SaidPlainKey>> = {
  provider_spend_cap: 'overview.hold.cause.failure.providerSpendCap',
  provider_usage_limit: 'overview.hold.cause.failure.providerUsageLimit',
  provider_subscription_disabled: 'overview.hold.cause.failure.providerSubscriptionDisabled',
  provider_auth_expired: 'overview.hold.cause.failure.providerAuthExpired',
  provider_overloaded: 'overview.hold.cause.failure.providerOverloaded',
  provider_refused_request: 'overview.hold.cause.failure.providerRefusedRequest',
  agent_startup_failed: 'overview.hold.cause.failure.agentStartupFailed',
  agent_skill_missing: 'overview.hold.cause.failure.agentSkillMissing',
  agent_exited_without_result: 'overview.hold.cause.failure.agentExitedWithoutResult',
  agent_killed: 'overview.hold.cause.failure.agentKilled',
  agent_stopped_on_question: 'overview.hold.cause.failure.agentStoppedOnQuestion',
  skill_not_synced: 'overview.hold.cause.failure.skillNotSynced',
  workspace_preflight_failed: 'overview.hold.cause.failure.workspacePreflightFailed',
  workspace_disk_full: 'overview.hold.cause.failure.workspaceDiskFull',
  repo_root_contention: 'overview.hold.cause.failure.repoRootContention',
  box_session_saturated: 'overview.hold.cause.failure.boxSessionSaturated',
  runner_unreachable: 'overview.hold.cause.failure.runnerUnreachable',
  duplex_channel_failed: 'overview.hold.cause.failure.duplexChannelFailed',
  session_lost: 'overview.hold.cause.failure.sessionLost',
  heartbeat_timeout: 'overview.hold.cause.failure.heartbeatTimeout',
  queue_timeout: 'overview.hold.cause.failure.queueTimeout',
  turn_never_reported: 'overview.hold.cause.failure.turnNeverReported',
  no_client_ack: 'overview.hold.cause.failure.noClientAck',
  checkout_unbound: 'overview.hold.cause.failure.checkoutUnbound',
  credential_mint_failed: 'overview.hold.cause.failure.credentialMintFailed',
  attachment_unreadable: 'overview.hold.cause.failure.attachmentUnreadable',
  box_cannot_confine_chat: 'overview.hold.cause.failure.boxCannotConfineChat',
  dispatch_failed: 'overview.hold.cause.failure.dispatchFailed',
  forge_budget_exhausted: 'overview.hold.cause.failure.forgeBudgetExhausted',
  runner_unsupported_type: 'overview.hold.cause.failure.runnerUnsupportedType',
  resume_failed: 'overview.hold.cause.failure.resumeFailed',
  residency_expired: 'overview.hold.cause.failure.residencyExpired',
  park_unanswered: 'overview.hold.cause.failure.parkUnanswered',
  audit_ran_blind: 'overview.hold.cause.failure.auditRanBlind',
  session_authority_refused: 'overview.hold.cause.failure.sessionAuthorityRefused',
  orphan_under_terminal_run: 'overview.hold.cause.failure.orphanUnderTerminalRun',
  pipeline_cancelled: 'overview.hold.cause.failure.pipelineCancelled',
  pipeline_completed: 'overview.hold.cause.failure.pipelineCompleted',
  pipeline_failed: 'overview.hold.cause.failure.pipelineFailed',
  migration_zombie_cleanup: 'overview.hold.cause.failure.migrationZombieCleanup',
  manual_ops_stale_chat_schedule: 'overview.hold.cause.failure.manualOpsStaleChatSchedule',
  user_cancelled: 'overview.hold.cause.failure.userCancelled',
  unclassified: 'overview.hold.cause.failure.unclassified',
};

/** The gates a run waits behind and the reasons a job is held for (`jobs/hold.ts`). */
const GATE: Readonly<Record<string, SaidPlainKey>> = {
  all_devices_exhausted: 'overview.hold.cause.gate.allDevicesExhausted',
  verify_unavailable: 'overview.hold.cause.gate.verifyUnavailable',
  retry_cooldown: 'overview.hold.cause.gate.retryCooldown',
  retry_rounds_exhausted: 'overview.hold.cause.gate.retryRoundsExhausted',
  non_retryable_terminal: 'overview.hold.cause.gate.nonRetryableTerminal',
  deploy_locked: 'overview.hold.cause.gate.deployLocked',
  issue_busy: 'overview.hold.cause.gate.issueBusy',
  contract_wait_unsettled: 'overview.hold.cause.gate.contractWaitUnsettled',
  pattern_review_pending: 'overview.hold.cause.gate.patternReviewPending',
  scope_held: 'overview.hold.cause.gate.scopeHeld',
  runner_stale: 'overview.hold.cause.gate.runnerStale',
  runner_too_old: 'overview.hold.cause.gate.runnerTooOld',
};

const STUCK: Readonly<Record<RunStuckRule, SaidPlainKey>> = {
  silent: 'overview.hold.cause.stuck.silent',
  lease_expired: 'overview.hold.cause.stuck.leaseExpired',
  lease_abandoned: 'overview.hold.cause.stuck.leaseAbandoned',
  disagreement: 'overview.hold.cause.stuck.disagreement',
  stranded: 'overview.hold.cause.stuck.stranded',
  overdue: 'overview.hold.cause.stuck.overdue',
};

export const failureCause = (cause: FailureCause): Said => say(FAILURE[cause]);

/** A box-reported blocker reads `blocked_on_<kind>`; any other gate this table lacks is a pause kind or a new gate, said generically. */
export function gateCause(gate: string): Said {
  const known = GATE[gate];
  if (known) return say(known);
  if (gate.startsWith('blocked_on_')) return say('overview.hold.cause.gate.blocked');
  if (gate === 'paused') return say('overview.hold.cause.gate.paused');
  return say('overview.hold.cause.gate.other');
}

export const stuckCause = (rule: RunStuckRule | null): Said =>
  rule ? say(STUCK[rule]) : say('overview.hold.cause.stuck.other');

export const personCause = (): Said => say('overview.hold.cause.gate.person');
