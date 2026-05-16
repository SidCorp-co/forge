-- Migrate existing pipeline_failed issues to the operator-driven failure model.
--
-- pipeline_failed was set by the legacy sweeper escalation path
-- (recovery-policy.ts, removed in PR-2) when an issue's recovery budget was
-- exhausted. The new model never sets this status — failures block via
-- manual_hold + failure_context with status preserved at the failing step.
--
-- For historical rows we cannot know the original pre-failure status, so we
-- park them at `on_hold` (operator-visible terminal-ish) with manual_hold=true
-- so the dispatcher's L1 gate skips them. The failure_context records that
-- they were migrated. Operator must explicitly resume + transition to choose
-- a fresh stage.

UPDATE issues
   SET status = 'on_hold',
       manual_hold = true,
       failure_context = COALESCE(failure_context, '{}'::jsonb) || jsonb_build_object(
         'migratedFrom', 'pipeline_failed',
         'migratedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'note', 'Status was pipeline_failed before PR-3 dropped the enum value. Choose a target stage (confirmed / approved / staging / closed) after clearing manual_hold.'
       ),
       updated_at = now()
 WHERE status = 'pipeline_failed';
