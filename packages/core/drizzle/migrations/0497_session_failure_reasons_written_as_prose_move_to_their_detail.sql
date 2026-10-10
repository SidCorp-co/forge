-- Session rows written before the cause set (ISS-877) still hold an agent's sentence, a runner error
-- or a prompt fragment in agent_sessions.failure_reason, which every reader that does not resolve the
-- cause showed as the reason (dev ISS-143). Each such value is kept by appending it to failure_detail,
-- and failure_reason becomes `unclassified`, the cause resolveFailureCause already read it as, so no
-- row changes the verdict it reads as; only where the sentence is stored moves. The list below is the
-- cause set (contracts failure-causes.ts:FAILURE_CAUSES) as this migration ships.
--
-- ROLLBACK: none for the contents; each row reads as it did through resolveFailureCause.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE "agent_sessions" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "agent_sessions"
   SET "failure_detail" = CASE
         WHEN "failure_detail" IS NULL OR btrim("failure_detail") = '' THEN "failure_reason"
         ELSE "failure_detail" || E'\n' || "failure_reason"
       END,
       "failure_reason" = 'unclassified'
 WHERE "failure_reason" IS NOT NULL
   AND "failure_reason" NOT IN ('provider_spend_cap', 'provider_usage_limit', 'provider_subscription_disabled', 'provider_auth_expired', 'provider_overloaded', 'provider_refused_request', 'agent_startup_failed', 'agent_skill_missing', 'agent_exited_without_result', 'agent_killed', 'agent_stopped_on_question', 'skill_not_synced', 'workspace_preflight_failed', 'workspace_disk_full', 'repo_root_contention', 'box_session_saturated', 'runner_unreachable', 'duplex_channel_failed', 'session_lost', 'heartbeat_timeout', 'queue_timeout', 'turn_never_reported', 'no_client_ack', 'checkout_unbound', 'credential_mint_failed', 'attachment_unreadable', 'box_cannot_confine_chat', 'dispatch_failed', 'forge_budget_exhausted', 'runner_unsupported_type', 'resume_failed', 'residency_expired', 'park_unanswered', 'audit_ran_blind', 'session_authority_refused', 'orphan_under_terminal_run', 'pipeline_cancelled', 'pipeline_completed', 'pipeline_failed', 'migration_zombie_cleanup', 'manual_ops_stale_chat_schedule', 'user_cancelled', 'unclassified');
