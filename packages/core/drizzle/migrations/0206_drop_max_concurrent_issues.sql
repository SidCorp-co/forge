-- The per-project concurrency cap is gone: a master agent on the box decides how
-- many issues run at once, weighing facts core cannot see (RAM, repo locks, what
-- that box has handled before). The reader was deleted in the same change, so
-- this strips the now-unread key rather than leaving 38 projects carrying a
-- number nothing honours.
UPDATE projects
SET agent_config = jsonb_set(
      agent_config,
      '{pipelineConfig}',
      (agent_config -> 'pipelineConfig') - 'maxConcurrentIssues'
    )
WHERE agent_config -> 'pipelineConfig' ? 'maxConcurrentIssues';
