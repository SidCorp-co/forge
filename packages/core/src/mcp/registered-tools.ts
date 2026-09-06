/**
 * The MCP tool surface this server is DECLARED to register.
 *
 * Read by two tests: one asks the running server for its tool list and
 * compares, the other asks whether any bundled runner skill names something
 * absent from it.
 */

// cm:edge naming -> docs/architecture/agent-surface.md — the deletion rule and the group each tool sits in live there in prose, and that doc is the authority a reader can always open; `ISS-894` is the tracker row the waves are logged on, but it sits at `draft`, which no list or pool view of this project shows, so a citation naming only the number reads as a dangling reference (ISS-926).
// cm:guard the registered surface is FROZEN here, and ISS-894 is why: the plan is to shrink it to the session-lifecycle group, and nothing went red when a tool was added or removed — so the list drifted in silence in both directions. Adding a tool is a decision; make it visible by editing this array in the same commit, and say in the message which wave it belongs to. A tool deleted without its callers moved is the other half, and `mcp_audit_log` is the authority on whether it had any.
// cm:guard split `mcp_audit_log` by `device_id IS NOT NULL` / `token_id IS NOT NULL` and by NOTHING else — `user_id` is populated for a device caller too (it is stamped `device.ownerId`), so a split on it reads 100% user and 0 device for every tool in the table. Measured 2026-09-01: `has_user_id` equals `device + pat` exactly on all six tools `7f0c5a56` deleted after claiming an audit-log split had cleared them; the correct split shows `forge_skill_facts.get` at 23 device calls, and the fleet hit the deleted tool at 09:07 that same day and read `not_found`. A tool is clear only when its device count is 0 AND the replacement route accepts a device token — `/api/skill-facts` is `requireAuth()`, which answers a device 401, so it was never a replacement for the callers that existed.
// cm:guard count over the WHOLE table and normalise the spelling — `count(*) ... WHERE replace(tool,'.','_') = <name with dots replaced>`, no date filter. A window answers a different question than the deleter is asking ("has anything ever called this", not "was it called lately"), and it is how the same correct-column split read 11 device calls for `forge_skill_facts.get` in one pass and 23 in the next. The spelling half is not hypothetical: this column stores `request.params.name` verbatim, and agents do send the underscore form the MCP client shows them — `forge_step_handoff_write` has 21 rows across seven boxes, `forge_skills_list` 32, `forge_memory_search` 15, every one `not_found`, and no query for the dotted name finds any of them.
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
  'forge_memory.revisions',
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
