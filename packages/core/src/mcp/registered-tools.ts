/**
 * The MCP tool surface this server is DECLARED to register.
 *
 * Read by two tests: one asks the running server for its tool list and
 * compares, the other asks whether any bundled runner skill names something
 * absent from it.
 */

// cm:edge naming -> docs/architecture/agent-surface.md — the deletion rule, the group each tool sits in and which half of the target is still owed live there in prose; that doc is the authority, and `ISS-894` is only the tracker row the waves are logged on, so a reader who has just the number has the log and not the rule.
// cm:guard the registered surface is FROZEN here, and ISS-894 is why: the plan is to shrink it to the session-lifecycle group, and nothing went red when a tool was added or removed — so the list drifted in silence in both directions. Adding a tool is a decision; make it visible by editing this array in the same commit, and say in the message which wave it belongs to. A tool deleted without its callers moved is the other half; the guard below says where the authority on that now lives, and it is no longer `mcp_audit_log` alone.
// cm:guard the device count is NOT the deletion gate any more, and reading it as one is how this surface freezes. Since ISS-931 `mcp/server.ts` stamps `device_id` NULL on every audit row, so every tool's device number is frozen non-zero and can never fall to zero; the clause it fed asked whether the callers a tool HAD could reach its replacement, and those callers are un-upgraded boxes that `requirePat` now 401s on every `/mcp` call whatever is registered. The gate is: no caller that can STILL reach `/mcp` loses the tool. That means (a) it is not one of the nine the fleet's `forge` CLI names — that CLI holds a `forge_pat_*`, so ISS-931 did not take its access away, and the copy installed on a box is the only place the list is readable — and (b) nothing else calls it on a token, read off `token_id IS NOT NULL` rows, `skills.skill_md` on the live instance, and the runner's own bundled orientation text. Refuse a tool with a live caller BY NAME; never widen a filter to cover it. `docs/architecture/agent-surface.md` holds the rule and the observable end state.
// cm:guard when you do read `mcp_audit_log`, split it by `device_id IS NOT NULL` / `token_id IS NOT NULL` and by NOTHING else — `user_id` is populated for a device caller too (it is stamped `device.ownerId`), so a split on it reads 100% user and 0 device for every tool in the table. Measured 2026-09-01: `has_user_id` equals `device + pat` exactly on all six tools `7f0c5a56` deleted after claiming an audit-log split had cleared them, and the fleet hit one of them at 09:07 that same day and read `not_found`. Count over the WHOLE table and normalise the spelling — `count(*) ... WHERE replace(tool,'.','_') = <name with dots replaced>`, no date filter — because this column stores `request.params.name` verbatim and agents do send the underscore form the MCP client shows them: `forge_step_handoff_write` has 21 rows across seven boxes, `forge_skills_list` 32, `forge_memory_search` 15, every one `not_found`, and no query for the dotted name finds any of them. LEFT join the registry onto the aggregate, never inner: a tool nothing has EVER called has no row at all, so an inner join drops exactly the tools this rule is looking for — that is why the wave-3 pass reported one device-free tool and `forge_memory.revisions`, at zero rows lifetime, was not it. "Lifetime" holds only while `enforceMcpAuditRetention` (`auth/mcp-audit.ts`) stays unwired, so read that function before spending a zero. There is no aggregate route over this table: `ISS-946`.
export const REGISTERED_TOOLS = [
  'forge_agent_sessions.get',
  'forge_agent_sessions.list',
  'forge_collaborators',
  'forge_comments',
  'forge_config',
  'forge_coolify_deploy',
  'forge_feedback',
  'forge_guide',
  'forge_health',
  'forge_issues',
  'forge_jobs.cancel',
  'forge_jobs.events',
  'forge_jobs.get',
  'forge_jobs.list',
  'forge_jobs.resume',
  'forge_knowledge',
  'forge_memory.delete',
  'forge_memory.feedback',
  'forge_memory.get',
  'forge_memory.search',
  'forge_memory.write',
  'forge_metrics.project_retry_rescues',
  'forge_metrics.project_step_durations',
  'forge_metrics.project_timeseries',
  'forge_metrics.session_failures',
  'forge_orgs.list',
  'forge_orgs.members',
  'forge_phase',
  'forge_pipeline_runs.get',
  'forge_pm.set_dependency',
  'forge_project_pipeline_runs',
  'forge_project_pm',
  'forge_projects.create',
  'forge_projects.get',
  'forge_projects.list',
  'forge_projects.update',
  'forge_reconcile',
  'forge_runners',
  'forge_schedules',
  'forge_skill_facts.get',
  'forge_skill_facts.list',
  'forge_skills.adopt',
  'forge_skills.create',
  'forge_skills.delete',
  'forge_skills.effective',
  'forge_skills.get',
  'forge_skills.list',
  'forge_skills.list_registrations',
  'forge_skills.push',
  'forge_skills.register',
  'forge_skills.sync_status',
  'forge_skills.update',
  'forge_step_handoff.delete',
  'forge_step_handoff.get',
  'forge_step_handoff.write',
  'forge_step_start',
  'forge_storefront_target',
  'forge_uploads',
  'forge_ux_findings',
];
