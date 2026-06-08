# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Style.** Every entry is read first by an end user, not a developer. Lead each bullet with a plain-language sentence describing what the user will see change; keep file paths, function names, and root-cause explanations on a separate italic `*Technical:*` sub-line. Full style guide: [`docs/guides/release.md` → Writing changelog entries](docs/guides/release.md#writing-changelog-entries--style-guide).

## [Unreleased]

### Changed

- **Opening an issue from the board now shows its key details and the most-used actions — status, priority, assignee, and "Open issue" — pinned at the top of the quick-open drawer, so you can review and act on it without scrolling.**
  *Technical: New `IssueQuickActions` row composed from the issues-list inline-edit primitives (`StatusEdit`/`InlineSelect`) + the shared `usePatchIssue`/`useTransitionIssue` hooks, rendered sticky at the top of the web-v2 `RunDetail` SlideOver; `pipeline-board` re-derives the open drawer's issue from the live `['issues']` cache so an inline edit reflects immediately. Frontend-only, no API/contracts change (ISS-390). Merge 888b0ddd.*

- **The project dashboard now uses the full screen width so cards fill wide displays instead of sitting in a narrow centered column, cutting down how far you have to scroll.**
  *Technical: Removed the max-w-6xl centered clamp on `(workspace)/projects/[slug]/page.tsx` (now `PageContainer width="wide"`, 1720px) and reflowed the card grid `lg:grid-cols-2 → xl:grid-cols-3` at wide breakpoints to match the full-width Issues/board screens. Tablet/mobile single-column stack unchanged (ISS-389). Merge e372184b.*

- **Pipeline steps that were automatically cleaned up when a run finished are now shown as a neutral "cleaned up" state instead of looking like failures, so a cleanly-completed issue no longer appears to have failed.**
  *Technical: Adds a shared job-status classifier (success / failed / benign-cleanup / stale-or-manual-cancel) and surfaces failureKind/failureReason on the pipeline read models; cancelled-cleanup renders muted with an explanatory tooltip instead of error-red across web-v2.*

- **The agent Sessions list now has a more compact header and richer session rows (start time and cost), with the session detail showing an elevated task list.**
  *Technical: Reworked web-v2 sessions-screen header (4 StatCards -> inline metric strip) + added Started/Cost columns (cost via a bounded per-page usage_records rollup in GET /api/agent-sessions); elevated the Agents & tasks section + task-count badge in the session detail.*

- **The pipeline run view now shows which device a run is executing on (by name) and its retry history, and Cancel now reliably stops a run instead of letting it silently restart.**
  *Technical: Part A: agent-sessions hydrator resolves deviceId→runner name (batch devices lookup, shared by list/search/detail); PipelineRunSummary gains jobs-sourced attempts[] + retrySummary {round/maxRounds/target} from the retry_of chain + payload._autoRetry; web-v2 run-detail renders a per-attempt timeline + round-robin badge. Part B: cancelPipelineRun atomically parks the linked issue at on_hold after the cascade (on_hold has no STATUS_TO_JOB_TYPE mapping → no auto-dispatch); orchestrator transition-subscriber guard blocks any non-user advance OUT of on_hold so the dying agent's termination-protocol can't silently re-dispatch — only a human Resume re-engages. Reuses the existing web-v2 on_hold banner + Resume CTA. Merge bf664dbf.*

- **Postman and Epodsystem credential rotations now keep the previous key valid for 24h, matching Coolify, so in-flight requests don't fail mid-rotation.**
  *Technical: Extract ROTATION_WINDOW_MS + mergeRotatedSecrets to a shared integrations helper; persist previousApiKey/previousTokenExpiresAt on apiKey-provider PATCH; add 401-fallback in postman/epodsystem clients gated by the expiry guard; extend scrubber to include previousApiKey.*

### Fixed

- **A pipeline could silently stall for about an hour when a job was dispatched to a runner that never picked it up — the dead job held the runner's only slot and blocked the next stage. The system now detects an unclaimed dispatch within a few minutes and recovers automatically (re-dispatching the work, or moving the issue on if it had already completed elsewhere).**
  *Technical: new `reconcileNeverClaimedDispatches` pass in `pipeline/sweeper.ts`, run every minute inside `runPipelineSweep`. Reaps `jobs` in `status='dispatched'` with zero `job_events` (no `started` ack) older than `PIPELINE_NEVER_CLAIMED_MS` (default 3min), routing them through the shared `finalizeFailedJob` verify-first path. Closes the gap between `reconcileOrphanedJobs` (session-driven; blind to an unclaimed dispatch whose inherited `agent_session_id` is non-terminal) and `runStaleSweep`'s 60-min backstop — which let an orphan hold the cap=1 slot + block strict-sequential for ~4h (ISS-378).*

- **A runner that genuinely finished its work no longer loses that work when its completion report races a server hiccup. If the job had been auto-failed by a timeout sweep in the meantime, the late "success" is now reconciled instead of rejected.**
  *Technical: `POST /jobs/:id/complete` (lifecycle-routes.ts) — when an `exitCode=0` arrives for a job already `failed` with a server-written reap marker (`session_lost` / `dispatch_unclaimed` / `stale`) and NO retry descendant is queued/dispatched/running/done, CAS-flip `failed→done` and run the normal success side-effects instead of `409 INVALID_STATE`. The active-retry guard prevents double-advance; verify-first on any scheduled retry already no-ops once the issue advances (ISS-378; the ISS-360 outage discarded a merged PR this way).*

- **CLI runners now pull skill updates pushed from Forge instead of silently running stale on-disk skills.**
  *Technical: Cut runner-v0.2.15 to publish the already-present skill.sync WS handler (forge-runner-core daemon/dispatch + workspace/skill_sync) past the stale v0.2.14 channel; bumped Cargo workspace version 0.2.11→0.2.15 + lock regen so update --check (CURRENT_VERSION=env!(CARGO_PKG_VERSION)) settles. Tag runner-v0.2.15 + dev1 live verify are out-of-band. Merge a033c16.*

- **Fixed the Issues screen so the top navigation progress bar no longer gets stuck part-way, list rows show each issue's real status, and linked/related issues are shown clearly instead of just an icon and a number.**
  *Technical: route-progress.tsx must not gate completion on the global useIsFetching count or self-fire on replaceState URL-sync; list rows should render the true lifecycle status instead of the collapsed statusToChip bucket; DepBadges should surface linked issue IDs, not emoji+count only.*

- **Pipeline jobs that fail mechanically (crash or non-zero exit) now automatically retry from the stage's entry point instead of getting stuck waiting for manual intervention.**
  *Technical: Removed the manual-hold/on_hold-as-block model: finalizeFailedJob reverts issue.status to JOB_TYPE_ENTRY_STATUS so the orchestrator re-dispatches; budget-exhausted/non-retryable failures park at `waiting` + close the stuck pipeline_run; classifyVerdict treats in_progress as pending for code/fix (the ISS-34 no-op fix). manual_hold/manual_hold_until/failure_context columns dropped (migration 0099). Merge 25d1ad13.*

### Added

- **The pipeline now reproduces bugs before planning: a new `clarified` status sits between `confirmed` and `approved`, and the clarify step runs on the happy path — it reproduces the bug (or validates the UX) in a live environment, attaches evidence and a root-cause hypothesis, and only then hands the issue to planning. Trivially-sized issues (per-stage `skipComplexities`, e.g. xs/s) skip clarify automatically, and projects that never enabled clarify keep their exact previous flow.**
  *Technical: `clarified` added to `issueStatuses` (migration 0093: CHECK constraint, `skill_registrations` stage moves confirmed→clarified + needs_info→confirmed, and a behavior-preserving `states.confirmed.enabled=false` backfill for projects without `autoClarify`). PIPELINE_STEPS re-wired (confirmed→clarify, clarified→plan; needs_info is human-gated again, registry v2). New `StageConfig.skipComplexities` folded into the soft-skip resolver (`resolveSkipTarget` complexity predicate, skip reason `complexity_skip`) so disabled-stage, missing-skill, and complexity skips share one chain + telemetry path. clarify promoted to a handoff-emitting step (`clarifyHandoff` schema; plan injects `[triage, clarify]`). Status added across contracts, web, web-v2 status maps.*

- **Project Settings now has a Testing tab where project owners can set the staging URL, staging API URL, named testing links, and test login credentials (passwords masked with a reveal toggle) — no database access needed.**
  *Technical: Frontend-only web-v2 Testing tab editing project.previewDeploy via existing owner-gated PATCH /api/projects/:id; preserves unknown jsonb keys, client-side URL/label validation mirrors previewDeployPatchSchema. Merge 105be93.*

- **The Activity page now shows a live, cross-project feed of agent conversations — filter by source, intent, or quality rating, page through history, and open any entry to read the full query and reply with token and timing details.**
  *Technical: New web-v2 `features/activity` (api/hooks/types/screen) consumes `GET /api/chat-logs` cross-project (no projectSlug). Built from the @/design kit; loading/empty/error via kit primitives. Usage represented as feed-derived token throughput; full per-project cost dashboard stays project-scoped (summary endpoint requires projectId). Queries keyed ['chat-logs']; replayOnReconnect invalidates it. Merge 0d0b673.*

- **The project Automation page now has a working PM tab: view and edit the PM Agent's cadence, run triggers, and settings, and browse its decision audit log.**
  *Technical: web-v2 automation feature gains a PM slice (types/api/hooks + PmScreen) backed by /api/projects/:projectId/pm/config (GET/PUT) and /pm/decisions (paginated); replaces the ComingSoon stub. Config edits are owner/admin-gated. Merge f52623b.*

- **The v2 Runners screen now has a per-device detail panel — open any device from the Runners list to rename it, see its status and configuration (platform, agent version, last seen, git-push credential), and assign or adjust the project pools (runners) bound to it. This brings v2 to parity with the v1 device settings page.**
  *Technical: web-v2 device-detail SlideOver in features/runners, opened by a per-row Manage action (no new route or sidebar item). Rename via PATCH /api/devices/:id; pools via GET /api/devices/:id/runners + POST/PATCH/DELETE /api/projects/:id/runners; reuses kit primitives + projects hooks. No core change (ISS-317). Merge 260a0e78.*

- **Project owners can now manage members from the new web app's Project Settings → Members tab: see pending invitations (before the invitee accepts), cancel one and re-invite, and change an existing member's role between Member and Admin. This fixes the previous inability to remove someone after they had been invited. The owner row stays protected — no role-change or remove control.**
  *Technical: web-v2 project-settings Members tab gains a Pending invitations list + cancel and an inline role-change Select, all owner-gated (canEdit). New owner/admin-gated GET & DELETE /api/projects/:id/members/invitations (revoke by validated ?email=, token never serialized) in packages/core; reuses existing PATCH /members/:userId (owner-role immutable). packages/web (v1) untouched. Merge 65b0cab.*

- **Postman integration per-project: configure a Postman workspace + collection and API key in project settings, and the Postman MCP tools become available to agents/skills running for that project.**
  *Technical: New provider='postman' on project_integrations (encrypted apiKey + workspace/collection config); a dispatch-time resolver renders it into the existing per-project mcpServers override (remote HTTP + Bearer) so CLI/desktop runners auto-inject the Postman MCP. forge_postman_target MCP tool exposes the write-target (workspace/collection) to skills without leaking the key.*

- **Web v2: attach files to new issues via picker, drag-and-drop, or pasting a screenshot, and view them on the issue's Attachments section. Issue descriptions now use the full column width, and the session view has a wider conversation, a pinned context rail, and a tidier action bar.**
  *Technical: web-v2 new-issue dialog sends inline base64 attachments[]; issue-detail renders an Attachments card via useAttachments; dropped the description max-w-[70ch] clamp; session thread widened (max-w-4xl xl:max-w-5xl), right rail made lg:sticky, Fork moved to overflow menu.*

- **Project owners can now archive a project from Project Settings → Advanced (type-to-confirm the project name). Archived projects disappear from the project list and stop running new pipeline jobs, but keep all their issues, comments, runs, and sessions — and can be unarchived at any time to restore them.**
  *Technical: Nullable projects.archived_at (migration 0092) + owner-gated POST /api/projects/:id/archive|unarchive; GET /api/projects excludes archived by default (?archived=1 to include); orchestrator.loadPipelineConfig returns cfg=null when archived. UI in web (Settings→Advanced) and web-v2 (Settings→Advanced tab).*

- **The issue detail page now surfaces why an issue is stuck and who must act, shows live agent progress with a heartbeat indicator, and gives a per-stage summary of what each pipeline step produced along with its time and cost.**
  *Technical: Adds BlockerBanner, LiveAgentPanel and per-stage StepArtifactCard components plus a clickable PipelineTracker spine to the web-v2 issue-detail screen, fed by existing pipelineHealth/failureContext/step-duration signals and the GET /api/issue-step-contexts handoff surface (ISS-377).*

- **You can now hold or unhold an issue directly from the issue detail page, with a clear badge showing when an issue is on manual hold (dispatcher paused from picking up new jobs).**
  *Technical: web-v2 issue detail: standalone manual-hold toggle in the Issue actions menu + manualHold badge, calling /issues/:id/manual-hold via the apiClient (separate from on_hold status transitions). Merge ef7902e.*

- **The project dashboard is now an operator landing page: a KPI band, a needs-your-attention queue with one-click actions, live pipeline runs, open-issues-by-status and 7-day spend breakdowns, a runners summary, and upcoming schedules — each linking to where the detail lives.**
  *Technical: Expanded web-v2 ProjectOverviewPage (app/(workspace)/projects/[slug]/page.tsx) into a mockup-driven card grid with a new features/project-dashboard namespace, reusing existing health/attention/pipeline-runs/step-durations/queue-stats/schedules hooks; trend charts + Pass-rate KPI degrade to 'coming soon' pending ISS-380.*

- **Project dashboards can now show trends over time — cost, throughput/burndown, cycle time, queue wait, runner utilization, and cache hit rate — bucketed by day or hour, served by a new project metrics time-series API.**
  *Technical: New GET /api/projects/:id/metrics/timeseries in packages/core (src/metrics) over six metrics, computed from usage_records, activity_log, jobs and the pipeline_run_step_durations view (no new collection); days capped 1..90, day|hour buckets, dense gap-filled series, owner/member auth. cache_hit_rate sourced from usage_records (deployed view lacks cache-token cols). health-routes avgCycleTimeDays work-start corrected to first in_progress/approved transition. Part 2 collection split to ISS-381. Merge 0804c77.*

- **Pipeline **session groups** can now be viewed and configured from Project Settings → Pipeline → Configuration: create/rename/delete groups, assign each stage to at most one group via a dropdown, and see an always-visible "Ungrouped" bucket — no more hand-editing raw JSON through MCP/REST.**
  *Technical: New session-groups editor (session-groups-card.tsx) in the v1 settings pipeline-config section; web PipelineConfig gains sessionGroups (Record<string,StageName[]>) + per-state StageConfig.sessionGroup, STAGE_NAMES adds needs_info (13-state parity). Save writes BOTH the full sessionGroups map and per-state states[x].sessionGroup. Backend updatePipelineConfig now delta-validates AUTO_STAGE_NEEDS_SKILL (only stages a patch transitions into enabled+auto need a skill), so a session-groups save no longer 409s on skill-less projects. Merge b055a03a (ISS-382).*

- **Forge now has an in-app What's New feed and a browsable Help/Docs hub, with a nav badge that flags release notes you haven't seen yet — so you can follow changes and learn how to use Forge without leaving the app.**
  *Technical: What's New feed (product-global release source + per-user last-seen nav badge) and Help/Docs hub reusing the ISS-305 docs API, help-button.tsx, and github-releases.ts; nav entry points wired in web and web-v2 (v2 docs hub already present).*

- **Headless CLI runners can now host interactive chat sessions, so you no longer need the desktop app open to chat with an agent on a server.**
  *Technical: Runner daemon handles the agent:start device-room frame and streams replies via PATCH /agent-sessions/:id, mirroring the desktop device-room contract; chat stays off the jobs table and the pipeline cap=1.*

- **forge-runner devices now keep themselves up to date automatically — new releases are pulled and applied without anyone running an update command on each machine, and any in-flight job or chat finishes before the runner restarts.**
  *Technical: Fixed the runner-distribution route so the self-updater manifest is reachable through the /api edge proxy (dual-mount + prefix-aware asset/install.sh URLs); manifest_url now derives {core}/api/install/latest.json. Auto-update defaults ON (serde default_auto) with config set update.auto + install.sh --no-auto-update opt-out; drain-to-idle (InflightGuard) before systemctl restart; periodic fetch-release re-ingest; /me/devices surfaces latestAgentVersion + agentOutdated with a web-v2 lagging badge. Merge 8d52bd4e.*

- **Forge can now manage Epodsystem-powered websites (ecommerce, blog, landing) end-to-end: connect a store with an API key, then let the pipeline build changes on a draft theme, verify them, and publish to live.**
  *Technical: New epodsystem MCP-injection integration cloned from the postman pattern (adapter/resolver/healthcheck + dispatcher inject), a website project kind with ecommerce/blog/landing domain templates, the forge_storefront_target MCP tool, 9 shop-* skills, skills-zip for remote runners, and a draft->main theme publish/rollback flow. crmk_ keys live only in the AES-256-GCM vault + dispatch payload — never DB jsonb/logs/API/build output. Merges 27882926 + b4745506.*

- **You can now configure Epodsystem and Coolify integrations directly from the redesigned (web-v2) integrations surface, including connection testing, HMAC secret rotation with one-time reveal, and the production-deploy confirmation gate.**
  *Technical: Frontend-only port of the v1 epodsystem-section/coolify-section into packages/web-v2/src/features/integrations; extends the v2 integrations api+hooks+types beyond Postman to generic create/update + rotateSecret/confirmProdDeploy/deliveries. Backend already complete. Full v1 retirement tracked separately in ISS-397.*

- **Project agent settings (custom system prompt, chat provider and model) can now be viewed and edited in the new web-v2 interface.**
  *Technical: New web-v2 features/app-config (api/hooks/types) + project-settings Agent tab, backed by GET/PUT /api/app-config/:projectId. Mirrors v1 Chat Agent (systemPromptOverride) + Providers/Tools (chatProviderId, chatModel). Antigravity/Device Integration dropped (v1 stubs); webhook/channels preview-only sections deferred (ISS-396). Merge dadac53f.*

- **A redesigned Integrations directory shows each provider's real connection status, with an adaptive detail view for testing, rotating, and disconnecting a connection plus delivery logs where the provider supports them.**
  *Technical: web-v2 integrations directory with a client-derived 4-state status machine (icon+text), capabilities-driven connection detail, read-only delivery-log viewer, and a render-layer secret-safety assertion (ADR 0013). Share/bind-existing tab, projects-using-connection list, Needs-reauth state, and delivery retry deferred to ISS-404 (F).*

- **New API endpoints to share an existing integration connection with another project/environment without re-entering its credentials, list which projects a connection is bound to, and retry a failed integration delivery.**
  *Technical: core: POST/GET /api/integration-connections/:id/bindings (bind-existing, no secrets, owner-only, 409 on provider+env clash) + POST /api/projects/:projectId/integrations/:id/deliveries/:deliveryId/retry (re-dispatch failed outbound via enqueueCoolifyDispatch). Adds findDeliveryById, listBindingsForConnection; type-only @forge/contracts shapes. web UI is F3 (ISS-408). Merge 34e38ad9.*

- **Integration connections now show a "needs re-authorization" status when their stored credential is rejected, so you know to re-enter it instead of seeing a generic error.**
  *Technical: New needs_reauth value in the connection health-status set (free-form text column, no migration); widen the HealthStatus/IntegrationHealthResult literals + card-status mapping. OAuth-first connect deferred — no provider supports an app-install OAuth flow today.*

- **You can now share an existing integration connection with another project from project settings, see which projects use a connection, retry failed webhook deliveries, and spot a connection that needs re-authorization — all without re-entering the credential.**
  *Technical: web-v2 features/integrations: bindExistingConnection / listConnectionBindings / retryDelivery on api+hooks; the connection-detail drawer renders a projects-using-this-connection list; the delivery-log viewer adds a Retry button on failed outbound deliveries; a new needs_reauth derived state reads raw lastHealthStatus==='needs_reauth' (IntegrationCardStatus stays a 4-value contract; needs_reauth maps to attention). Core surfaces lastHealthStatus on coolify/postman/epodsystem card.meta. Merge baf3afb0.*

- **The Agent chat panel now has a "New chat" button and a history switcher to browse past conversations, plus a recovery prompt to start fresh when a chat ends in a failed state.**
  *Technical: web-v2 features/session/components/chat-screen.tsx: wire setActiveId via New-chat button + session-history dropdown; failed-session banner gated on classifySessionOutcome().bucket==='failed'. features/session/api.ts: add pageSize param to listByType (default 1, chat list passes ~20). Frontend-only, no backend change. Merge 2d006b62.*

### Changed

- **The Forge MCP tools that were prefixed `forge_admin_*` have been renamed to reflect what they actually are — ordinary project-scoped tools, not system-admin tools. `forge_admin_runners` → `forge_runners`, `forge_admin_users` → `forge_collaborators`, `forge_admin_health` → `forge_ops_health`; project archive moved onto `forge_projects.archive`; and the cross-your-projects metrics tool is now `forge_metrics.step_durations`. Access is unchanged — every one stays gated by your role on each project. The token-creation dialog no longer claims the `admin` scope grants "cross-tenant admin tools".**
  *Technical: renamed forge-admin-{runners,users,health}.ts → forge-{runners,collaborators,ops-health}.ts (tool names + exports + tests); folded forge_admin_projects' `archive` action into a new `forge_projects.archive` (forgeProjectsArchiveTool) and dropped its duplicate list/create; `forge_metrics.admin_step_durations` → `forge_metrics.step_durations`. server.ts registration + lib.ts/forge-projects.ts comments + web token copy (CreateTokenModal/TokenRow) updated. No auth change — all tools remain project-membership/role gated; no client referenced the old names. Follow-up: ISS-365 retires the now-vestigial PAT `admin` scope.*

- **You can now configure a project directly in the new web app — name & description, repository path, base/production branches, pipeline stages, labels, and members — reached from the project dashboard's gear icon or the ⌘K command palette, with no new sidebar item. Edits persist immediately and project secrets are never shown.**
  *Technical: web-v2 features/project-settings: nested /projects/[slug]/settings route (Basics/Repository/Pipeline/Labels/Members/Integrations tabs) wired to PATCH /projects/:id, GET|PATCH pipeline-config, and labels + members REST; owner-gated edits, secrets never rendered. Merge b62e3ef (ISS-316).*

- **Workspace Settings now helps you connect MCP clients and control notification delivery: the MCP tab generates a ready-to-paste connection snippet for Claude CLI, Cursor, Cline, Zed, or any client and lets you test the connection live, while the Notifications tab adds a toggle to turn @mention alerts on or off — your choice is saved.**
  *Technical: web-v2 features/settings: MCP tab (mcp-tab.tsx + mcp.ts) builds per-client snippets + a live JSON-RPC tools/list test against core /mcp, with the endpoint origin derived from NEXT_PUBLIC_API_URL (fixes cross-origin beta). Notifications toggle wired to GET/PATCH /api/auth/me/preferences; new user_preferences.notify_on_mention (migration 0090) gates the mention notification server-side. No secret echo, no new sidebar item. Merge b67e6cdc.*

- **You can now create a new project right from the new web app — the Overview console button, the dashed "New Project" tile, and the project-switcher in the left rail all open a real create form (name, auto-derived slug, optional description) that creates the project on the backend and takes you straight to it. The old "Coming soon" placeholder is gone, and the new project shows up in the list immediately.**
  *Technical: web-v2 features/projects: NewProjectDialog (kit SlideOver) wired to POST /api/projects via useCreateProject (invalidates ['projects'] for live refresh + navigates to /projects/:slug). Client validation mirrors createProjectSchema; inline SLUG_TAKEN (409) + form-level Banner via kit Field. All triggers + rail ?new=1 deep link share one dialog; home wrapped in Suspense. No new sidebar item, no feature flag. Merge dcbf0d0.*

- **The issue detail page in the new web app is easier to read and act on: the primary action + state bar now stays pinned at the top while you scroll, the properties rail stays in view alongside it, the layout uses the full desktop width instead of a narrow centered column, the breadcrumb shows the project's name instead of its slug, status/priority/complexity show friendly labels instead of raw codes, the newest comment appears first, Open sessions is one click from the bar, and the cluttered Run step / Reopen header actions are gone (status changes stay available from the properties rail).**
  *Technical: web-v2 issue-detail refactor: shared STATUS/PRIORITY/COMPLEXITY label maps + helpers in derive.ts; sticky top-0 action+state bar; sticky properties rail (lg:sticky top-20 self-start, max-h calc overflow-y-auto); breadcrumb project name from cached useProjects() (slug fallback); container max-w-[1600px] 2xl:1760px + widened rail track; reverse-chron top-level comments (copy sort); Open sessions promoted, Run step/Reopen removed. Merges 7f410a2 + 17f4381 (ISS-347).*

- **Agent session detail pages in the new web app now render the full conversation — assistant text and tool calls in their original order — for pipeline and CLI-runner sessions that previously showed an empty "No messages yet" screen. The page also shows which device/runner the session is running on (name, platform, and online status) and surfaces "Open issue" as a primary action instead of hiding it in the overflow menu.**
  *Technical: web-v2 session parser reads the canonical block shape and falls back to session.messages when /turns is empty; core messageRoleToTurnRole falls back to entry.type so derived sessions populate turn rows going forward. Merge c9ddd75.*

- **The new web app now looks consistent across screens: every tabbed screen (Settings, Project Settings, Library, Automation, and Agents on mobile) shares the same tab strip and ?tab= deep links, and issue status, priority, and complexity show readable labels (e.g. "Medium", "Critical", "In progress") everywhere — lists, tables, mobile cards, and menus — not just the detail view.**
  *Technical: web-v2: new ScreenTabs pattern unifies the tab-strip container (max-w-6xl + overflow-x-auto) across 5 screens; Settings/Project-Settings converge from #tab hash onto the shared useTabParam (?tab=). Issue row cells/menu + detail Tasks tab route through derive.ts label helpers (+ new TASK_STATUS_LABELS); dead duplicate IssueTableRow removed. Merge 427100d.*

- **On the issues page you can now reach every issue — including closed and draft ones. Classic app: a one-click Select all in the status filter. v2 app: a Drafts tab and an All + drafts tab that shows everything (drafts included) in one list. The default view still hides AI-draft proposals until you opt in.**
  *Technical: Discoverable draft/closed issues on both web surfaces. v1 (packages/web status-multi-select.tsx): sticky Select all / Clear header + honest trigger label ("Active (no drafts)" default, "All statuses" when full). v2 (packages/web-v2 derive.ts/issues-screen.tsx): "All" tab sends statusNot:['draft'] (closed shown), "Drafts" tab (status:['draft']), and "All + drafts" tab (no status filter => every issue incl. draft+closed). ISS-236 default (drafts hidden until opted in) preserved. Merges 7a4300a (v1) + 88dca6a + 6f9653e (v2).*

- **The workspace landing page is now an Overview dashboard — KPIs, a needs-attention inbox, a work-distribution bar, spotlight projects, and recent activity — instead of a flat project list. The full project list moved to its own Projects page.**
  *Technical: Frontend-only redesign of the /v2 landing route in packages/web-v2; new features/overview module built from existing hooks (no API/core changes), full ProjectsConsole relocated to /v2/projects. Merge fd0c759.*

- **Opening the classic Overview now takes you to the redesigned workspace Overview (v2). Other classic screens are unchanged for now — screens move to the new UI one at a time.**
  *Technical: Added a V2_MIGRATED_PATHS exact-match map + redirect branch to packages/web middleware, placed after the auth gate. Authed hits on a migrated v1 path redirect to its /v2 equivalent (proxy routes /v2/* to web-v2). First entry: /dashboard -> /v2. Each future screen = one map entry.*

- **The new web app's navigation is now project-first: the project switcher is pinned at the top of the sidebar and opens on hover, click, or keyboard — with "View all" and "Create project" actions — and the project pages (Dashboard, Issues, Agents, Library, Automation) sit above the workspace links. The top bar now shows a breadcrumb (workspace → project → page) instead of a single title, while keeping ⌘K search, notifications, and New issue.**
  *Technical: web-v2 nav-rail + nav-rail-compact reordered to project-first (PROJECT cluster above WORKSPACE); hover open/close timers lifted into WorkspaceShell and shared by the switcher + project-flyout; flyout gained View all + Create project (→ /projects, /projects?new=1) and re-anchored to the top; TopBar title replaced by the existing Breadcrumb primitive. Merge 1e6fb45 (ISS-358).*

- **The new web app's navigation reads more clearly: breadcrumbs now reflect where you actually are instead of always starting with "Overview", the collapsed sidebar labels its Project and Workspace sections, and hovering the project switcher opens its panel cleanly without flicker. The Activity section is replaced by a new Usage screen that fills wide monitors with a full-width layout.**
  *Technical: web-v2 follow-up to ISS-358: breadcrumb root derived from route context (Workspace/Overview, Workspace/<Page>, Projects/<Project>/<Page>); RailKicker tier labels in nav-rail-compact; switcher click-away catcher scoped to left-[232px] to stop flyout flicker; new PageContainer wide-layout standard (max-w-[1720px]) exported from @/design; /activity route + workspace ActivityScreen removed, replaced by /usage UsageScreen (sample data behind preview banner). Merge 4f5c85d.*

- **Redesigned the Issues and Agents screens (web-v2): the project nav is now Dashboard/Issues/Agents/Library/Automation, the Issues list is a wide table whose "All" filter includes drafts, the issue-detail view is restored with Run/Pause/Reopen actions, and agent/session status is now visually distinct from issue status.**
  *Technical: web-v2 frontend only: PROJECT_ITEMS trimmed to 5 (Pipeline folds into Issues, /pipeline still reachable via ⌘K); IssueFilter collapsed to all/active/review/blocked with all→{} (reverses ISS-236); removed doubled in-page Breadcrumb on issue-detail (shell TopBar owns it) — the reported regression; StatusChip gains domain:issue|session. Merge 8a6b476.*

- **Issue relationships now display clearly: the detail rail shows distinct Parent, Subtasks, Duplicates, and Related sections, and the Issues list/cards show epic (subtask count) and subtask markers alongside the blocked-by/blocks badges.**
  *Technical: web-v2: depCounts adds subtasks/hasParent from decompose edges; properties-rail splits the Related bucket and drops raw kind labels; IssueRefBadge gains an optional status tone dot.*

- **You can now attach files to comments on the new issue-detail page: the comment and reply boxes accept a Choose-files button, drag-and-drop, and pasted screenshots (⌘/Ctrl+V), and each posted comment shows its attachments as image thumbnails or download links.**
  *Technical: core GET /api/issues/:id/comments now joins comment_attachments into the tree (buildCommentTree takes an attachmentsByCommentId map; empty-ids guarded); web-v2 composer stages files against the comment allow-list (png/jpeg/gif/webp, pdf, text/plain, text/markdown — no video, ≤10 MB, ≤10/comment) then create-then-multipart-uploads each via POST /api/comments/:commentId/attachments; an upload failure toasts but keeps the posted comment. AttachmentGrid extracted to a shared AttachmentList used by both issue + comment attachments.*

- **Redesigned the project Issues screen with a Board / List / Insights view switcher: a pipeline kanban, the full-featured issues list, and a new analytics view (per-stage counts, durations, cost, and throughput). The active view is shareable via the URL.**
  *Technical: web-v2: issues-screen.tsx split into thin container + IssuesListView + new IssuesInsightsView; Board embeds PipelineBoard (new `embedded` prop); view state via useTabParam(?tab=); added median()/aggregateStageInsights() in pipeline/derive.ts. Frontend-only.*

- **The Issues page now opens the redesigned interface with Board, List, and Insights views.**
  *Technical: Legacy web /projects/:slug/issues routes (list, new, detail) now hand off to the web-v2 /v2 Issues experience (ISS-364 redesign). Merge 667a29d.*

- **The Agents screen now shows a per-runner fleet overview with queue depth, surfaces each session's runner, live/stale state and failure reason with clickable issue and run links, warns when work is queued but no runner is online, and makes the Agent Chat panel collapsible so the session list can use the full width.**
  *Technical: Reworked packages/web-v2 agents feature (agents-screen, sessions-screen) with a FleetRunnerStrip from queue-stats×useDevices, a unified deriveLiveness threshold aligned to the server zombie-sweep heartbeat bound, an on-demand chat dock persisted per user, and a new read-only GET /api/agent-sessions/:id/cost usage_records rollup.*

- **The pipeline run timeline now makes Pause vs. Stop unambiguous — Pause shows it's finishing the current step before halting, a separate Stop control aborts the running agent immediately, and each step shows whether it resumed the same agent session or started fresh.**
  *Technical: Pure frontend rework of RunDetail (web-v2 run-detail.tsx): transitional/halted pause states + distinct Stop wired to existing cancel; TimelineTab derives session-group continuity (resumed/fresh, group labels, connectors, operator detail) from agent_sessions metadata.sessionGroup + claudeSessionId + deviceId + status.*

- **In Skill Studio, built-in skills are now read-only templates; to customize one for a project you create a project copy that shadows the built-in. The old per-project override/fork mechanism has been removed.**
  *Technical: Removed forge_skills.override_set/override_delete MCP tools, the skills override REST routes, the project_skill_overrides table (+ drop migration), and the override-merge branch / isOverridden flag in effective.ts. forge_skills.list & effective now dedup by name (project shadows global, one row per name + shadowsGlobal marker).*

- **Pipeline steps that were automatically cleaned up when a run finished are now shown as a neutral "cleaned up" state instead of looking like failures, so a cleanly-completed issue no longer appears to have failed.**
  *Technical: Adds a shared job-status classifier (success / failed / benign-cleanup / stale-or-manual-cancel) and surfaces failureKind/failureReason on the pipeline read models; cancelled-cleanup renders muted with an explanatory tooltip instead of error-red across web-v2.*

- **The agent Sessions list now has a more compact header and richer session rows (start time and cost), with the session detail showing an elevated task list.**
  *Technical: Reworked web-v2 sessions-screen header (4 StatCards -> inline metric strip) + added Started/Cost columns (cost via a bounded per-page usage_records rollup in GET /api/agent-sessions); elevated the Agents & tasks section + task-count badge in the session detail.*

- **The pipeline run view now shows which device a run is executing on (by name) and its retry history, and Cancel now reliably stops a run instead of letting it silently restart.**
  *Technical: Part A: agent-sessions hydrator resolves deviceId→runner name (batch devices lookup, shared by list/search/detail); PipelineRunSummary gains jobs-sourced attempts[] + retrySummary {round/maxRounds/target} from the retry_of chain + payload._autoRetry; web-v2 run-detail renders a per-attempt timeline + round-robin badge. Part B: cancelPipelineRun atomically parks the linked issue at on_hold after the cascade (on_hold has no STATUS_TO_JOB_TYPE mapping → no auto-dispatch); orchestrator transition-subscriber guard blocks any non-user advance OUT of on_hold so the dying agent's termination-protocol can't silently re-dispatch — only a human Resume re-engages. Reuses the existing web-v2 on_hold banner + Resume CTA. Merge bf664dbf.*

### Removed

### Fixed

- **You can now create an issue directly from web-v2 (the “New issue” button opens a dialog), and clicking an agent session opens its detail view instead of 404ing. Issues and sessions now cross-link — open an issue's sessions, jump from a session back to its issue — and block/decompose relations show clickable ISS-X badges. Raw UUIDs no longer lead on the issue and session screens.**
  *Technical: Added issuesApi.create + useCreateIssue + NewIssueDialog (?new=1 trigger); restored /projects/[slug]/agents/[sessionId] route + clickable session rows; repointed dead /sessions/:id hrefs to /agents/:id; enriched core GET /issues/:id/dependencies with both endpoints' displayId/title/status; shared IssueRefBadge.*

- **Creating an issue in the web app now takes you straight to the new issue's detail page after you submit, instead of dropping you back on the issues list.**
  *Technical: web/src/app/projects/[slug]/issues/new/page.tsx now router.push's to /projects/<slug>/issues/<displayId ?? id> on create success (V1 root surface), matching web-v2. Merge 119a7e1.*

- **Agent sessions that completed normally are no longer mislabeled as 'failed' — pipeline steps that finish a run (such as test and release) now show a green done status, and previously mislabeled sessions are corrected automatically. The session detail view also gains cache-token counts, lifecycle timing, the repository path, an 'Agents & tasks' list of sub-agent and skill calls, and a 'Sessions for this issue' list.**
  *Technical: core: cascadeCancelChildJobs maps close-reason 'pipeline_completed' to session status 'completed' (failureReason null), keeping pipeline_failed/cancelled as 'failed'; migration 0091 backfills existing (failed, pipeline_completed) rows. web-v2 session context-rail: cache tokens, timing, repoPath, deriveAgentTasks, sibling-session list. Per-session cost/model deferred to a usage_records join. Merge 84c3343.*

- **Web v2 pages no longer show a duplicated page title (the section label in the top bar stacked on top of each page's own heading).**
  *Technical: Stop the workspace TopBar from rendering the nav-section label as an <h1>; the page/screen header becomes the single title source. Single edit in (workspace)/layout.tsx.*

### Security

- **Deploy logs no longer expose environment secrets in plaintext.**
  *Technical: Coolify deploy-log scrubber now redacts secret-shaped KEY=value lines (segment-match on PASSWORD|SECRET|TOKEN|KEY|PASS|PEPPER|DSN|CREDENTIALS) and adds defense-in-depth around the build-stage .env dump. Touches @forge/observability scrubLogText + packages/core coolify/logs.ts; live-verified on forge-beta deploy ec8b1df2 (ISS-412). Merges 19e21c95, ec8b1df2.*

## [0.2.11] - 2026-05-31

Device-centric runner management and a redesigned v2 navigation with a cross-project Attention inbox and mobile tab bar, plus self-healing pipelines — wedged runner slots now auto-recover within minutes.

### Added

- **Runner management is now device-centric — each device has its own page showing the projects and runners bound to it, with a clearer pairing / runner-onboarding flow.**
  *Technical: New per-device management path (ISS-273) on top of the runner framework, plus runner-onboarding UX fixes. Merge 9d00232f.*
- **The `forge-runner doctor` command now gives a clear online/offline verdict so onboarding problems are obvious at a glance.**
  *Technical: doctor reconciles the runner's heartbeat against the server's /me/runners view and exits PASS/FAIL (ISS-272). Merge ff97cd8a.*
- **The `forge_coolify_deploy` MCP tool gained a `logs` action — release/deploy skills can now read Coolify build & deploy logs (secrets scrubbed) directly over MCP.**
  *Technical: New `logs` action fetches a deployment's Coolify log, redacts secrets line-by-line, tails to ~100 lines/16KB (ISS-284). Merge 1eacf97c.*

### Changed

- **Comments are no longer copied into the project's searchable memory — this cuts embedding cost with no loss of recall, since memory search and the AI pipeline never read comment entries (issues and learned fix-patterns are still indexed).**
  *Technical: dropped the commentCreated/Updated/Deleted memory-indexer subscribers (packages/core/src/memory/indexer.ts); rewrote the agent system prompt's forge_memory guidance onto the real .search/.write API (the old text described non-existent strategy/role/category/global params Zod would reject) and steered agent-written learnings to source:'knowledge'.*
- **Removed the legacy device-routing path (activeDeviceId) and unified all job dispatch on the runner framework; orphaned or stale devices no longer block job dispatch.**
  *Technical: Deleted active-device.ts and the dispatchViaDevice branch, retired the runnerFramework flag (now always-on), and dropped activeDeviceId from the forge_config response. Orphan/never-connected devices are skipped at select time and swept online→offline by the device stale-detector.*

- **Redesigned v2 navigation: the left sidebar now shows only top-level destinations, project sections moved into horizontal tabs, and a new cross-project Attention inbox gathers everything waiting on you (reviews, blocked issues, mentions, failed jobs, offline runners) with a live count. On phones a bottom tab bar plus a project-switcher drawer replace the sidebar.**
  *Technical: web-v2 Concept B nav: workspace-only NavRail with NavItem.badge, new projects/[slug]/layout.tsx + ProjectTabBar, features/attention/* against GET /api/me/attention merged with /me/devices offline runners, BottomTabBar pattern, per-project RoomSub WS fan-out, ['attention'] invalidations in event-router.*

- **You can now trigger a Coolify redeploy without tying it to an issue — `forge_coolify_deploy {action:'deploy'}` works with just the project (pass an integration id when more than one is active), so shipping the latest main to forge-beta no longer requires a pipeline run.**
  *Technical: deploy action makes issueId optional: when absent it resolves the integration like the logs action and dispatches run-less via dispatchCoolifyDeployDirect (runId nullable through types/queue/adapter, the !runId throw dropped); prod human-confirm gate preserved. Merge f177b7a (ISS-312).*

### Removed

- **The non-functional "Add member" action has been removed — it previously called a project-members endpoint that did not exist and always failed with a 404.**
  *Technical: Removed the dead phantom POST to `/api/projects/:id/members` (no such route) (ISS-281). Merge 50f6bc39.*

### Fixed

- **A runner slot no longer gets permanently wedged when an agent dies without reporting completion — orphaned dispatched/running jobs are now reaped within minutes and auto-retried, so the pipeline keeps moving.**
  *Technical: Reverse session→job reconciliation (pipeline/sweeper.ts reconcileOrphanedJobs + jobs/finalize-failure.ts) reaps jobs whose linked agent_session is terminal, routing them through the normal auto-retry / manual-hold path; part of the ISS-258/259 orphan-job hygiene family (ISS-280). Merge 7e2fc1d4.*
- **The web session view now works for jobs run by the CLI runner — it shows the agent transcript just like the desktop app (CLI-runner jobs previously showed nothing).**
  *Technical: Web session view derives the transcript from agent_sessions for CLI-runner jobs, reaching parity with desktop (ISS-283). Merge 10b2026a.*

- **The new /v2 web app is now polished and brand-compliant — the sidebar shows the real Forge logo, the account menu (Settings, Sign out) works, navigation collapses into a mobile drawer with no sideways scrolling, unknown URLs show an on-brand "Page not found", not-yet-built pages show a friendly "Coming soon" instead of a hard 404, and all text renders in the brand fonts (Hanken Grotesk + JetBrains Mono).**
  *Technical: web-v2 shell completion + brand pass: sidebar logo via assetPath('/forge-mark-32.png'); footer Menu wired to /settings + logout(); responsive md: hamburger drawer (>=44px targets, safe-area insets); global not-found.tsx; ComingSoon placeholders for /activity + /projects/[slug]/pm; 3 raw-token->semantic swaps; brand fonts fixed by scoping next/font vars to <html>. Merge eb0be34.*

- **The /v2 web app now shows trustworthy status and metrics: pipeline trackers reflect each issue's real state (no longer always "running"), per-issue cost and average cycle time display real figures instead of a bulk "—" or a misleading "0d", throughput and count labels carry clear timeframes/definitions, the issues table and mobile (375px) header no longer overflow, and menus are fully keyboard-operable.**
  *Technical: web-v2 + core: re-linked per-issue cost via distinct agent-session ids, computed avgCycleTimeDays over the trailing-7d window, hydrated agentStatus on GET /api/issues/:id, gated route-progress on useIsFetching()===0, unified live/active labels, responsive breakpoints, a11y (keyboard menus, focus rings, aria-labels). Merge 2c2399e.*

### Security

## [0.2.10] - 2026-05-28

Pipeline jobs finish immediately even when the Claude CLI lingers after its work (completes ISS-264 runner-completion fix)

### Added

### Changed

### Removed

### Fixed

- **Pipeline jobs now finish the instant the agent is done, even when the Claude CLI process keeps running in the background — completing the fix shipped in 0.2.9, which still stalled whenever `claude` lingered after its work (it holds its MCP server children open and does not exit). Jobs no longer sit "in progress" for an hour before being falsely failed.**
  *Technical: claude_cli/spawn.rs — the stdout reader now stops the moment it parses the final `type:"result"` line (the last message in stream-json `--print` mode) instead of waiting for stdout EOF or `child.try_wait()` to report exit. 0.2.9's exit-poll never fired because `claude` stays alive holding stdout via MCP grandchildren, so `agent:complete` was never emitted and `/api/jobs/:id/complete` never POSTed. Breaking on `result` lets the completion task run immediately and reap the whole process group (claude + MCP servers) via graceful_kill. Completes ISS-264.*

### Security

## [0.2.9] - 2026-05-28

Pipeline no longer stalls when an agent finishes while an MCP server holds the output stream open

### Added

- **New `forge_coolify_deploy` MCP tool (list / deploy / status) — the stock release/staging skills can now drive Coolify deploys without hitting "tool-not-found", and manual + automatic deploy paths share the same idempotency key so a release cannot accidentally deploy twice.**
  *Technical: Action-dispatcher tool in packages/core/src/mcp/tools/forge-coolify-deploy.ts (membership-gated). deploy reuses tryDispatchCoolifyRelease with requestId=${runId}:${integrationId}; new findDeliveryByRequestId guard in release-coolify.ts dedupes manual + auto paths. Prod integrations return pendingHumanConfirm:true without dispatch. resolveLatestIssueRunId helper extracted from the release subscriber. Stock skill call sites updated to pass { issueId } since MCP context carries no run id.*
- **New `draft` issue status — AI-generated proposals (from Dream / Doc-Sync schedules) land here for human review before entering the normal pipeline. Promote to open or discard with one click.**
  *Technical: Extended issueStatuses enum + issues_status_chk constraint. State machine allows draft→open and draft→closed only. All dispatchers updated to skip drafts.*

### Changed

- **Pipeline now auto-advances past stages that have no skill registered for them instead of stalling — projects can run with a partial skill set (e.g. only triage/plan/code/review/test) and issues still walk to closed without manual config tweaks.**
  *Technical: Extended resolveSkipTarget with a hasSkill predicate sourced from ProjectSkillResolver.stages(); orchestrator's autoSkipDisabledStages now consults it before the ISS-238 missing-skill guard. Each hop appends to pipeline_runs.metadata.skipChain with a typed reason (stage_disabled | missing_skill). Pipeline-config service surfaces non-blocking warnings[] for enabled-default stages without a skill outside PIPELINE_STEPS.*

### Removed

### Fixed

- **Pipeline jobs no longer get stuck forever after an agent finishes — the desktop runner now reliably reports completion even when an MCP server keeps the output stream open, so the next step (plan → code → review …) starts right away instead of silently blocking the whole project queue until a stale-timeout.**
  *Technical: claude_cli/spawn.rs completion path now races stdout EOF against child-process exit (try_wait poll loop) instead of awaiting stdout to EOF. MCP server grandchildren spawned by `claude` inherit the stdout/stderr pipe and keep it open after `claude` itself exits, so the reader blocked forever, `agent:complete` never fired, and the runner never POSTed /api/jobs/:id/complete — the job sat at `dispatched`, held the cap=1 runner slot, and was later false-reaped as `heartbeat_timeout`. Result/usage-limit/claudeSessionId are now persisted incrementally so they survive aborting the reader; stderr + emitter awaits are time-bounded; the process group is reaped to clean up lingering MCP servers. Fixes ISS-264.*
- **Coolify integration healthcheck and deploy now hit real Coolify v4 endpoints — the "Test connection" button stops returning 404, deploys actually reach Coolify, and the dead Rollback action that always 404'd has been removed.**
  *Technical: client.getResource() now lists /api/v1/resources and resolves the uuid client-side (no get-one-by-uuid route exists in v4). client.deploy() switched to GET /api/v1/deploy?uuid=&force=, parses the deployments[] array. Removed client.rollback() + POST /api/projects/:id/integrations/:id/rollback route + the matching web hooks (no such API exists in v4). Live-token verification deferred to operator.*
- **Saving a Coolify integration on a server missing INTEGRATION_MASTER_KEY now shows an actionable remediation banner instead of a bare "Internal Server Error" — operators see exactly what env var to set.**
  *Technical: Added isVaultConfigured() guard in integrations/routes.ts (POST always, PATCH only when patch.secrets.apiToken is present) returning HTTPException 503 with code VAULT_NOT_CONFIGURED. coolify-section.tsx narrows ApiError on that code to a fixed remediation string; happy path untouched.*

### Security

## [0.2.8] - 2026-05-26

Pipeline self-heals through quota caps, runner blips, and long-running sessions

### Added

### Changed

- **Pipeline now keeps retrying through quota caps and runner blips instead of giving up after one attempt.** Previously when an agent session hit Claude's hourly usage limit (e.g. "You've hit your session limit · resets 7:30pm") or any runner-side blip that produced the generic "Agent completed with errors" message, the pipeline tried exactly once more after a 60-second cooldown and then halted with the issue stuck mid-pipeline — operators had to clear the manual hold by hand and could lose hours waiting until they noticed. The retry budget now expands to 40 attempts across two phases (30 retries spaced 1 minute apart, then 10 retries spaced 5 minutes apart), covering ~80 minutes of provider/runner recovery before the issue falls to manualHold. Multi-device projects also rotate runners on each retry, so a single misbehaving device no longer locks the issue. Long-running sessions are no longer cut at 30 minutes — the global agent timeout has been removed, with the server-side heartbeat sweeper (3-minute default) and per-state `timeoutSeconds` overrides remaining as the only watchdogs.
  *Technical: `packages/core/src/jobs/retry.ts` replaces `MAX_AUTO_RETRIES_UNKNOWN=1` + null-budget transient/timeout kinds with a single phased schedule (`AUTO_RETRY_PHASE_1_COUNT=30`, `AUTO_RETRY_PHASE_2_COUNT=10`, `AUTO_RETRY_PHASE_2_COOLDOWN_MS=300_000`, `AUTO_RETRY_MAX_TOTAL=40`). Provider `Retry-After` hints still override the phase floor. Retries write `payload._autoRetry.excludeDeviceId = job.deviceId`; `packages/core/src/jobs/dispatcher.ts` reads it and drops the session-group pin when it matches; `packages/core/src/runners/select.ts` adds an optional `excludeDeviceId` to `selectRunnerForJob` that skips primary + standby picks, then falls back without the exclusion when no alternative is online so single-device projects still dispatch. `packages/dev/src-tauri/src/claude_cli/spawn.rs` drops `DEFAULT_AGENT_TIMEOUT: Duration::from_secs(30 * 60)` and makes `timeout_seconds=None` mean "no cap" instead of falling back to 30 minutes.*

### Removed

### Fixed

### Security

## [0.2.7] - 2026-05-25

Pairing failures now show up in Sentry; runners Use toggle no longer 500s

### Added

### Changed

### Removed

### Fixed

- **Device pairing failures are now visible on the dashboard instead of silently swallowed.** When sign-in's auto-pair fails server-side (issue creating the device row), when the desktop can't write the device token to the OS keychain (gnome-keyring not running on Linux is the common case), or when the periodic 25s heartbeat stops landing because the token was revoked or the server is unreachable, the previous build emitted at most a `console.warn` — invisible to on-call and to anyone without devtools open. Now each of those paths reports to Sentry with `area=desktop-pairing` / `area=desktop-runner` tags and an outcome tag (`unauthorized` vs `transient`), so a pairing regression surfaces as one issue per affected install instead of as user complaints that "device không pair được" with no server-side trail.
  *Technical: forge-core `packages/core/src/auth/desktop/pairing-routes.ts` adds `Sentry.captureException` at the `issueOrRotateDeviceToken` catch site (tags `area=desktop-pairing, phase=auto-pair-device-create`). forge-dev `packages/dev/src/pages/app/LoginPage.tsx` wraps `store_device_token` and the post-login heartbeat verification (added in v0.2.6) with explicit captures; the heartbeat path splits 401/UNAUTHORIZED (level=error) from transient network failures (level=warning) so on-call can correlate the client 401 with the matching forge-core `auto-pair-device-create` event. `packages/dev/src/hooks/use-web-socket.ts` replaces the periodic heartbeat's empty `catch {}` with a fail-streak tracker — first two consecutive failures stay as breadcrumbs (likely transient), the third escalates to `Sentry.captureException`, and any 401 escalates immediately — preventing spam from one-off network blips while ensuring a stuck device emits one event per minute instead of going silent forever.*
- **Project Settings "Use" toggle for runners now succeeds instead of returning HTTP 500.** The unified `runners` upsert introduced with ISS-172 was triggering `SQLSTATE 42P10` on every real device pairing because the partial unique index `runners_project_device_type_uq` requires the ON CONFLICT predicate to be repeated. Users were seeing the Settings → Devices "Use" button flash an error toast on every click — now binds and unbinds work as designed.
  *Technical: `packages/core/src/projects/runners-routes.ts` adds `targetWhere: sql\`device_id IS NOT NULL\`` to the Drizzle upsert so the generated SQL matches the partial index. Migration `0067` had introduced the predicate; the upsert code from `04dcdf97` only specified `target: [...]` without it. Sentry issue FORGE-CORE-5.*

### Security

## [0.2.6] - 2026-05-25

Verify auto-pair via heartbeat + manual pair-code fallback in desktop Settings

### Added

### Changed

### Removed

### Fixed

- **Signing in on a fresh machine no longer leaves the desktop stuck in a "paired" state that the web can't see.** After v0.2.5 the auto-pair flow could finish locally — Settings showed a green "Device paired" card with a device id — while `/me/devices` on the web stayed empty, so users had no way to bind the device to a project and no obvious recovery path short of reinstalling. The desktop now verifies the auto-paired device id with a heartbeat right after sign-in; if the server rejects the token, the local device id is cleared so Settings falls back to the pair-code form. The green Device-paired card also carries a new "Pair with a code instead" link so the user can redeem a fresh project pairing code in-place when the auto-pair silently disagreed with the server.
  *Technical: `packages/dev/src/pages/app/LoginPage.tsx` invokes the `heartbeat` Tauri command with the freshly-minted device token after `auth.login()`; a `UNAUTHORIZED`/401 response calls `useAuthStore.getState().setDeviceId("")` so `PairDeviceCard` renders `UnpairedDeviceCard` without a re-sign-in. `Settings.tsx` introduces a `manualOverride` toggle inside `PairDeviceCard`, with an `onPairWithCode` callback exposed by `PairedDeviceCard` and an optional `onCancel` on `UnpairedDeviceCard` to swap back. Root cause: `issueOrRotateDeviceToken` in `packages/core/src/auth/desktop/pairing-routes.ts` catches DB/insert errors but does not surface them to the client — heartbeat is now the desktop's source of truth for "is this device actually addressable on the server".*

### Security

## [0.2.5] - 2026-05-25

ISS-200 sign-in now also registers the desktop as a device. Previously the user was authenticated but the desktop didn't appear in `/me/devices`, so project Settings → Devices stayed empty and the desktop kept showing the legacy "Pair Device" card — forcing a second manual pairing step just to use the machine as a runner.

### Added

### Changed

- **Signing in via the pairing code now also registers the desktop as a runner-capable device.** Before v0.2.5 the user had to run the sign-in pairing AND a second project-scoped device pairing from `/settings/devices` just to see the desktop in project Settings → Devices. Now the device row + device token are minted at sign-in time and surfaced in `/me/devices`; project owners can toggle "Use" on it without any extra step on the desktop.
  *Technical: `GET /api/auth/desktop/poll` now calls `issueOrRotateDeviceToken` after consuming a pairing code and returns `{ token, user, device: { id, token } }`. The helper dedupes by `(ownerId, name, platform)` and rotates the token in place when an existing non-revoked device matches — same-machine re-sign-in doesn't clone rows. Desktop `LoginPage.tsx` stores the device token via a new `store_device_token` Tauri command and passes `device.id` into `auth.login`, which flips Settings from `UnpairedDeviceCard` to `PairedDeviceCard`. Auto-pair failure is logged but does not block sign-in.*

### Removed

### Fixed

### Security

## [0.2.4] - 2026-05-25

Hotfix for v0.2.2/v0.2.3: after signing in via the new pairing flow, the desktop's WebSocket bar stayed "Disconnected" because the upgrade went out without any Authorization header.

### Added

### Changed

### Removed

### Fixed

- **The desktop now stays connected after signing in via pairing code.** v0.2.2/v0.2.3 left the WebSocket badge stuck on "Disconnected" right after first sign-in. The pairing flow issues a user JWT, but the WS client only ever read a device token from the OS keychain — which doesn't exist on a freshly-paired install — so the socket upgraded anonymously and the server 401'd it. The WS client now falls back to the user JWT from the auth store when no device token is paired, and the badge flips to "Connected" once the socket is up.
  *Technical: `packages/dev/src/hooks/use-web-socket.ts` — `connect_ws`'s `deviceToken` param now resolves to the keychain's `device_token` if present, else the in-memory user JWT (`auth.token`). Server-side `resolveBearer` already accepts either principal type in that order (`packages/core/src/ws/server.ts`), so no server change needed. Also fixed a stale comment claiming anonymous upgrades were accepted — they have been 401'd since ISS-286.*

### Security

## [0.2.3] - 2026-05-25

Hotfix for v0.2.2: desktop sign-in's pairing link no longer 404s on subdomain-split deploys (e.g. forge-beta.sidcorp.co + forge-beta-api.sidcorp.co).

### Added

### Changed

### Removed

### Fixed

- **The "Sign in via the web" link from the desktop now opens the right host.** v0.2.2 sent users to `https://<api-host>/connect-device?code=…`, which 404s on any deploy where the API and web app live on different subdomains. The desktop now builds the link from the web URL the user typed at the login screen — the same host that actually serves the connect-device page.
  *Technical: `packages/dev/src/lib/pairing.ts` was building `connectUrl` from `apiBase` (the value returned by `/.well-known/forge-config.json` discovery, i.e. the API origin). Switched to `opts.coreUrl` (the user-typed URL, which is the web origin by design). Updated the `webBaseFrom` docstring to reflect the corrected input contract. Single-origin deploys are unaffected — `coreUrl` and `apiBase` point at the same host.*

### Security

## [0.2.2] - 2026-05-25

Desktop sign-in switches to a pairing-code flow that works on Linux/Wayland, headless SSH sessions, and browsers that ignore custom URL schemes — replacing the old `forge-beta://` deep-link.

### Added

### Changed

- **Desktop sign-in now uses a short pairing code instead of a browser deep link.** On the desktop login screen, click "Sign in via the web", read the displayed code, open the matching URL in any signed-in browser, paste the code, and click Approve — the desktop signs in automatically. The pairing flow works on Linux/Wayland, headless SSH-forwarded sessions, macOS, and Windows, including browsers that ignore custom URL schemes (ISS-190 root cause).
  *Technical: ADR 0019 supersedes ADR 0017. Adds `desktop_pairing_codes` table (migration 0074) + `POST /api/auth/desktop/{pair-init,approve}` and `GET /poll` with 10-min TTL, sha256(code) at rest, per-IP rate limits (20/h init, 10/h approve), single-use atomic UPDATE-RETURNING. Adds `/connect-device` Next.js page + `desktop-pairing-cleanup` pg-boss sweeper. Desktop client (`packages/dev/src/lib/pairing.ts`) polls every 2 s (5 s after 30 s). Drops `oauth_handoff` table and the entire PKCE deep-link surface.*

### Removed

- **The `forge-beta://auth/callback` deep-link handler is gone.** The Tauri app no longer registers a custom URL scheme; the old `/auth/desktop/handoff` web bridge page is deleted; the old `/api/auth/desktop/{start,issue-code,exchange}` endpoints return 404. Existing v0.1.x desktop installs can't sign in until they update to a build with the pairing client.
  *Technical: drops `tauri-plugin-deep-link` from `Cargo.toml` + `tauri.conf.json`; removes `DEEP_LINK_EVENT`/`on_open_url`/`redact_oauth_url` from `packages/dev/src-tauri/src/main.rs`; drops `oauth_handoff` table in migration 0074; renames `desktopOauth` feature flag to `desktopPairing`.*

### Fixed

### Security

## [0.2.1] - 2026-05-23

Re-cut v0.2.0 with the Windows desktop build restored, plus CI link-check and Dependabot qs unblocks.

### Added

### Changed

### Removed

### Fixed

- **The v0.2.0 release ships a Windows desktop binary again.** The v0.2.0 tag's Windows build failed at `actions/checkout` — three retries in a row hit "could not read Username for github.com" — so the published `v0.2.0` release only attached macOS and Linux artifacts. Plain re-running the failed job wouldn't have helped without a code change; v0.2.1 re-cuts the release with the Windows checkout fix included.
  *Technical: Windows runners ship `credential.helper=manager`, which intercepts the AUTHORIZATION header `actions/checkout` injects via `http.extraheader` and falls back to a prompt that GH Actions has disabled (`GIT_TERMINAL_PROMPT=0`). `.github/workflows/release.yml` now runs `git config --global credential.helper ""` in a Windows-only step before checkout. Also folded in: docs link-checker fix (track `.claude/skills/{forge-code,forge-plan,forge-release}/{references,scripts}/` so CI's markdown-link-check can resolve the cross-links — the SKILL.md overrides were tracked but the files they linked to were hidden by the blanket `.claude/` gitignore), `desktop-oauth` flaky timeout test (start setup under real timers and switch to fake timers only after the deep-link handler is wired — under fake timers from the start, the async PKCE `crypto.subtle.digest` chain raced the `expect(currentHandler).not.toBeNull()` assertion), and a pnpm override forcing `qs ≥ 6.15.2` to clear the open Dependabot security alert (body-parser + express transitively pin 6.15.1).*

### Security

## [0.2.0] - 2026-05-23

Create and edit Forge projects from Claude Code/Cursor/Cline, upload screenshots without base64, and recover from any stuck pipeline transition automatically — plus clearer MCP auth errors.

### Added

- **You can now create and edit Forge projects directly from Claude Code, Cursor, or any other MCP client.** Previously the only paths were the web UI's "New project" button or `forge_admin_projects.create` (CEO-gated). Two new user-facing tools cover create + edit for any user with a PAT carrying the `write` scope.
  *Technical: `forge_projects.create` + `forge_projects.update` in `packages/core/src/mcp/tools/forge-projects.ts`. Update is owner-gated to match REST `PATCH /api/projects/:id` (admin-role members refused — see Fixed). Create returns the new project's `apiKey` in the response so PAT-only clients can install MCP into it immediately. PATs with a `projectIds` allowlist are refused from create — allowlisted PATs are intentionally scoped to existing projects.*

- **AI agents and CI scripts can now upload images and attachments to issues and comments without the old MCP base64 path.** A new `scripts/upload-image.sh` driver takes `--issue <id>` or `--comment <id>` plus a file path and uploads via multipart, returning a JSON array of attachment metadata. The Forge skills (`forge-code` / `forge-plan` / `forge-release`) now call it in place of the inline-base64 MCP path, which was capped at 10 files and inflated screenshot token cost ~1.3×.
  *Technical: new `requireAnyAuth` middleware in `packages/core` accepts user JWT, PAT (`forge_pat_*`), or device token. Attachment upload routes are split out (`issueAttachmentRoutes`) and mounted before `issueRoutes` under `/api/issues` so they route through the combined middleware instead of `requireAuth + assertEmailVerified`. 21 tests cover all three principals on both endpoints. The script reads `FORGE_API_URL` + `FORGE_API_TOKEN` from env.*

- **Issues now have a typed `releaseNotes` field for end-of-pipeline changelog generation.** The forge-clarify / forge-release skills can write a structured `{ section, summary, technical? }` object onto every issue; `forge-release` reads it at merge time and appends the bullet to `CHANGELOG.md`. Replaces the planned "parse a `## Release notes` section out of the description" workaround.
  *Technical: migrations `0071_issues_release_notes.sql` (adds `release_notes jsonb`) + `0072_backfill_release_notes.sql` (idempotent lift of any pre-existing description-section data — zero hits on main). `ReleaseNotesSchema` (zod) lives in `packages/core/src/issues/release-notes.ts`, re-exported via `@forge/contracts` so web + desktop share the type. Section enum is `Added | Changed | Fixed | Removed | Security | Skip`. `forge-clarify` SKILL.md grows a "Draft Release Notes" step; `forge-release` skips on `null` / `Skip`.*

### Changed

- **Pipelines now self-heal when an issue's status update commits but the in-process trigger hook never fires.** Until now, if the trigger handler crashed mid-fan-out — or a path other than the orchestrator (raw SQL UPDATE, MCP, custom script) mutated the status — the issue could sit idle in an auto-dispatch state forever. A transactional outbox produced by an AFTER UPDATE OF status trigger now ensures every status change reaches the orchestrator, and a 1-minute reconciler rescues anything still stuck.
  *Technical: ISS-196. New `pipeline_outbox` table (migration `0070`) populated by an `AFTER UPDATE OF status` trigger on `issues`. Outbox worker (`packages/core/src/pipeline/outbox-worker.ts`) drains it and re-emits `hooks.emit('transition')`. Reconciler (`packages/core/src/pipeline/reconciler.ts`) sweeps stuck-at-auto-status issues every 60 s and emits a Sentry breadcrumb when outbox lag exceeds 5 min. A `pg_advisory_xact_lock` per issue serialises `considerEnqueue` across workers; pg-boss `singletonKey` becomes `${issueId}:${jobType}` so sibling outbox rows collapse to one queued message. Clean-break: `registerDispatchTickBackstop` removed; no feature flags or fallback path.*

### Removed

### Fixed

- **Connecting Claude Code / Cursor / Cline to the Forge MCP server now reports the actual auth error instead of "Invalid OAuth error response: ZodError".** A 401 from `POST /mcp` — typically an expired or wrong PAT — used to silently trigger OAuth Dynamic Client Registration, which then 404'd on `/register`; users saw the misleading OAuth-parse error and couldn't tell their token was the real problem. The 401 response now advertises plain Bearer auth via `WWW-Authenticate`, which tells spec-compliant clients to stop and surface the original 401.
  *Technical: per RFC 6750 §3 + the MCP authorization spec, a Bearer-only `WWW-Authenticate` challenge suppresses the DCR fallback. Plumbed via `HTTPException.cause.wwwAuthenticate` so the central error handler attaches the header; gated on `status === 401` so future 5xx responses can't emit a challenge. Malformed Authorization headers (empty Bearer / non-Bearer scheme) use `error="invalid_request"` per the same spec.*

- **`forge_projects.create` returns a clear `SLUG_TAKEN` error on duplicates instead of a raw Drizzle "Failed query".** The unique-violation helper was checking the top-level error code, but with `drizzle-orm/postgres-js` the SQLSTATE lives on `err.cause.code` — so duplicates leaked the underlying SQL error to the MCP client.
  *Technical: `packages/core/src/lib/db-errors.ts` — `isUniqueViolation` walks both top-level and `cause`; new `uniqueViolationConstraint()` helper exposes the constraint name (e.g. `projects_slug_idx` vs `projects_api_key_unique`) so callers can disambiguate.*

- **`forge_projects.update` over MCP is now owner-only, matching the REST PATCH endpoint.** The original gate used `assertPrincipalIsAdmin`, which also accepted `role='admin'` — letting admin-role members rewrite project settings via MCP while REST refused them.
  *Technical: tightened to inline `project.ownerId === userId || role === 'owner'`; returns NOT_FOUND on non-members to avoid existence leaks. Separate bug fixed in the same pass: zod v4 `.strict()` doesn't strip explicit-`undefined` values, so the patch schema now refines on `Object.values(o).some(v => v !== undefined)` to prevent an empty-SET `UPDATE projects SET  WHERE id=$1`.*

### Security

## [0.1.35] - 2026-05-22

Desktop sign-in becomes observable end-to-end and stops asking first-launch users to type the API URL. Linux users who saw Forge Beta hang silently after the browser handoff now get a phase-by-phase status on screen (and a matching Sentry breadcrumb trail if telemetry is on).

### Added

- **The sign-in button reports what step the OAuth flow is on.** Instead of a static "Sign in with…" label that sat unchanged for up to five minutes, the button now shows `Opening browser… → Waiting for browser sign-in… → Received callback… → Signing in… → Finalising…`. If the exchange step takes longer than 10 s, a "still working…" hint appears so the user knows it isn't frozen. Failed flows now name the phase they died at instead of a generic "OAuth failed".
  *Technical: ISS-190. `signInWithProvider` emits lifecycle phases via an `onPhase` callback (`starting → awaiting-deep-link → deep-link-received → exchanging-code → exchanged → timed-out / failed`) with matching `category: "oauth"` Sentry breadcrumbs. Single 5-min hard timeout split into 5 min browser-wait + 30 s post-deep-link. `auth-store.login()` emits per-step breadcrumbs so a hang inside `persistKeychain()` (libsecret without `gnome-keyring-daemon`) is distinguishable from a hang in cache-clear or `save_config`. Rust `on_open_url` + single-instance deep-link paths log to stderr and emit `category: "deep-link"` breadcrumbs with `code` / `handoff_id` redacted to `<len:N>`. +172 LOC of new tests at `packages/tests/dev/lib/desktop-oauth.test.ts`.*

- **First-launch users see the production API URL pre-filled on the login screen.** The server-URL field used to default to `http://localhost:8080` (renderer) or `http://localhost:1337` (Rust config seed), so anyone installing Forge Beta for the first time had to manually type the URL before they could sign in.
  *Technical: official release artifacts now bake `FORGE_DEFAULT_CORE_URL` (Rust, via `option_env!`) and `VITE_DEFAULT_CORE_URL` (renderer, via `import.meta.env`) from the GitHub Actions repository variable of the same name. Source builds without the variable still fall back to the localhost defaults so `npm run tauri dev` works out of the box. Wired in `packages/dev/src-tauri/src/config/mod.rs`, `packages/dev/src/pages/app/LoginPage.tsx`, `packages/dev/src/hooks/use-tauri-ipc.ts`, and `.github/workflows/release.yml`. Existing installs that already wrote `localhost` to `~/.config/forge-beta/config.json` are not migrated automatically — fresh installs only.*

### Fixed

- **Rust-side Sentry now emits a boot probe so a missing DSN is visible at a glance.** Previously the `forge-dev-rust` Sentry project showed zero events for 30 days, indistinguishable between "Rust never panicked" and "the DSN didn't actually bake into the build". Each launch of an official release now sends one Info-level `forge-dev-rust booted vX.Y.Z` event so the dashboard confirms telemetry is wired.
  *Technical: `packages/dev/src-tauri/src/main.rs` — `sentry::capture_message(...)` immediately after `sentry::init` returns a non-None guard. No PII; one message per process start.*

## [0.1.34] - 2026-05-21

The pipeline now uses ~30–60% fewer tokens per issue thanks to smarter server-side prompt caching, and the cost dashboard finally shows real numbers (it used to display $0 on every step). MCP integrators: the `forge_pm.flag_blocker`, `forge_pm.escalate`, and `forge_tasks` tools were removed — see the migration table below.

### Added

- **AI agent gets full issue context upfront — no more "fetching" round-trip at the start of each step.** Title, status, priority, plan, and acceptance criteria are now included directly in the prompt sent to Claude. Each pipeline step starts ~200–500 ms faster and uses fewer tokens.
  *Technical: `buildJobPromptString` accepts an optional `issueSnapshot` with per-state field policy at `packages/core/src/jobs/prompt-string.ts`. Orchestrator loads it in parallel with `buildPreventiveContext` at both manual and auto enqueue sites.*

- **Resumed work (forge-fix, forge-review, repeat-coding) inherits decisions from the previous attempt.** The agent now sees a summary of what was decided, which files were touched, and what review feedback was raised — rather than re-discovering it via tool calls.
  *Technical: `## Previous Session Context` block renders when `issues.sessionContext.sessionCount >= 1`, gated by per-state field policy (review reads filesModified + decisions only; fix gets the full trail).*

- **Shared pipeline rules now ship as a single cacheable preamble.** Every step (triage, plan, code, review, …) used to repeat the same status / branch / output rules in its own skill file. Those rules now ship once at the top of each agent invocation, which lets Claude's prompt cache reuse them across consecutive steps in the same project — that's where the ~90% input-token saving on the system block comes from.
  *Technical: `buildPipelinePreamble(projectId)` in `packages/core/src/lib/chat-preamble.ts`; dispatcher forwards on `job.assigned` (both device + runner-adapter paths); desktop relays via `--append-system-prompt` in `claude_cli/agent.rs`.*

- **Storage groundwork for the upcoming Prompt Inspector + cost analytics surfaces.** New columns on `jobs` and a content-addressable `prompt_blobs` table can hold a snapshot of every prompt the server ever sent, deduplicated. The write path is wired in a follow-up release; this one just lands the schema so the migration runs once and stays stable.
  *Technical: migration `0068_job_prompt_snapshot.sql` adds `prompt_blobs (hash, content, ref_count)` + 6 columns on `jobs` (`system_prompt_hash` FK, `user_prompt_snapshot`, `prompt_input_token_est`, `model_used`, `prompt_blocks`, `archive_path`) + partial index `jobs_finished_archive_idx`.*

- **Internal helper for estimating prompt token counts.** Used by the upcoming budget-preview + block-contribution analytics views; no user-visible change yet.
  *Technical: `packages/core/src/lib/token-estimator.ts` — heuristic ~3.6 chars/token, FIFO LRU cache, zero deps.*

### Changed

- **PM escalation lives on `forge_pm.write_decision` now, not a separate tool.** If you call `write_decision` with an `escalate` block, the same call creates the `pm_escalation` notification — one API trip instead of two. Existing callers that don't pass `escalate` keep working unchanged.
  *Technical: `forge_pm.write_decision` accepts optional `escalate: { severity, summary, question, options, expiresAt }`. Response gains `escalation: { notificationId, expiresAt }` when the block was provided. Replaces `forge_pm.escalate`. ISS-146.*

- **Skill markdown files are leaner.** Status / branch / output / learning-capture rules are no longer repeated inside each `SKILL.md`; the shared preamble owns them. No behaviour change — the same rules still reach the agent every step.
  *Technical: 8 of 9 SKILL.md files trimmed (forge-triage left untouched as the canonical examplar). Total ~62 LOC removed (1446 → 1384). State-specific procedures preserved.*

### Fixed

- **The Insights → Cost dashboard now reports real spend per pipeline step.** Every triage / plan / code / review / test / release / fix row used to read $0 USD regardless of the worker's actual cost. The next pipeline run on a desktop carrying this build will populate real numbers within seconds.
  *Technical: `usage_records.session_id` was storing the local Tauri job id instead of the forge `agent_sessions.id`, so the `pipeline_run_step_durations` view JOIN never matched. The usage accumulator moved into `packages/dev/src/hooks/use-web-socket.ts` where the pipeline `agent:complete` handler already has the canonical `agentSessionId` from `job.assigned`; per-job usage is now deduped by `message.id` and POSTed once on completion with the forge UUID as `sessionId`.*

### Removed

- **MCP tools deprecated for some time are now gone: `forge_pm.flag_blocker`, `forge_pm.escalate`, `forge_tasks` (all CRUD).** Integrations that still call these will start getting "tool not found" errors — migrate to the replacements before updating. ISS-146.

  | Removed tool | Replacement call shape |
  |---|---|
  | `forge_pm.flag_blocker` | `forge_comments` `action='create'` (body `**PM blocker flagged** …`) + `forge_issues` `action='transition' data.status='on_hold'` |
  | `forge_pm.escalate` | `forge_pm.write_decision` with the new optional `escalate` block (`{ severity, summary, question, options, expiresAt }`) |
  | `forge_tasks` `create`/`list`/`update`/`delete` | `forge_issues` actions `createTask` / `listTasks` / `updateTask` / `deleteTask` (task data lives on `data.taskTitle` etc.; list requires `filters.issue`) |

  *Technical: MCP audit rows previously tagged `tool='forge_tasks'` now log `tool='forge_issues'` with the corresponding action — adjust downstream dashboards accordingly.*

- **Dead code cleanup in the desktop runner.** A stale internal hook (never wired into the running app since the dev/prod chat split) was removed; no user-facing behaviour change beyond a faster cold start.
  *Technical: `packages/dev/src/hooks/use-agent-stream.ts` deleted (-226 LOC). It used to be the (broken) usage-record POST source; see the Fixed section above for the replacement. Zustand state fields (`agentMessages`, `setAgentRunning`, …) stay in the store — still used by `useAgentChat` / `useAgentChatHandlers`.*

## [0.1.31] - 2026-05-06

Persistent Forge MCP config sent the wrong credential — fixed.

### Fixed

- **Forge MCP `/mcp` always 401'd from Claude CLI, then OAuth fallback 404'd** (desktop). The persistent MCP config written into `<repo>/.mcp.json` by Project Settings → Save / MCP page → Install had `X-Forge-API-Key` as the auth header. But `packages/core` migrated `/mcp` to device authentication in ISS-202 — the only accepted credential is `Authorization: Bearer <device-token>`. With the wrong header the request 401'd; Claude CLI's MCP SDK then auto-attempted OAuth dynamic-client registration (`POST /register`) which the backend doesn't implement, surfacing as `HTTP 404: Invalid OAuth error response: ZodError` with raw body `{"code":"NOT_FOUND","message":"Not Found: POST /register"}`. The ephemeral MCP config emitted by the Tauri runtime in `claude_cli/mcp.rs` already used the Bearer header — only the persistent path was stale. Fix: `useProjectSettings.ts:ensureForgeMcp`, `mcp-server-list.tsx`, and `McpPage.tsx` now load the device token from the OS keychain via `load_device_token` IPC and write `Authorization: Bearer <token>` instead of `X-Forge-API-Key`. The project apiKey path is dropped from the desktop MCP install entirely (it remains valid for the web widget, which is unrelated).

## [0.1.30] - 2026-05-06

## [0.1.30] - 2026-05-06

Desktop fixes for fresh installs on macOS Apple Silicon.

### Fixed

- **`Failed to spawn claude: No such file or directory (os error 2)` on macOS** (desktop). GUI launches inherit a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew (`/opt/homebrew/bin`), nvm, npm-global, and `~/.local/bin`, so `Command::new("claude")` returned ENOENT even with the CLI installed. Fix at process startup: probe the user's login shell once with `$SHELL -lc 'echo $PATH'`, sentinel-parse, and `setenv("PATH", …)` for the whole process. All subsequent spawns (claude, git, gh) resolve against the user's real PATH. Same approach VS Code / Atom / GitHub Desktop / JetBrains use.
- **`Sync to server Error: API error: 404` from Project Settings save** (desktop). The desktop was calling three Strapi-era endpoints — `POST /api/devices/register`, `PUT /api/devices/project-path`, `PUT /api/devices/projects-root` — that were never ported to `packages/core`. The backend has no schema for per-device project paths and the dispatcher reads project-level `projects.repoPath` instead, so the round-trip was dead weight. Removed the three frontend callers; per-device paths still persist locally in `~/.config/forge-beta/config.json` and survive restarts.

### Removed

- `registerDesktop` / `unregisterDesktop` / `registerDevice` / `setDeviceProjectPath` / `setDeviceProjectsRoot` from `packages/dev` — all five were no-ops or 404s on `packages/core`. Logout no longer takes an `unregisterDesktop` flag.

## [0.1.29] - 2026-05-05

Pipeline session fix: long-running jobs (plan/code/fix/review) no longer get killed by the queue_timeout sweeper, and a completed pipeline session opened in the browser shows the assistant reply + claudeSessionId instead of an empty placeholder.

### Fixed

- **Pipeline jobs killed by `queue_timeout` sweeper after ~5min** (server, ISS-36 / PR #85). Every plan/code/fix/review session was being marked `failed` with `failureReason='queue_timeout'` ~5 minutes after dispatch. Root cause: the desktop runner uses `jobId` as its local session key, so its `PATCH /api/agent-sessions/:id` and relay calls 404'd against the actual `agent_sessions` row UUID. Pre-#83 the session was inserted at `status='running'` so the queue_timeout sweeper didn't match; #83 changed insert to `'queued'` and the sweeper started killing every long-running session before completion. Fix: when a device POSTs `/api/jobs/:id/events`, the server now also CASes the linked `agent_sessions` row `queued → running` (stamps `startedAt`) and bumps `lastHeartbeatAt`. Best-effort, doesn't break event ingest. No desktop change required for this part.
- **Completed pipeline sessions show empty messages in the browser** (server + desktop, ISS-37 / PR #86). The session row's `messages`, `claudeSessionId`, and `diff` stayed empty after the job finished — only the row's status got updated via `syncAgentSessionLifecycle`. Fix: server threads the linked `agentSessionId` through the claude-code adapter into the WS `job.assigned` payload; desktop tracks the `jobId → agentSessionId` mapping and calls `patchAgentSession(agentSessionId, { status, messages, claudeSessionId })` on `agent:complete` so the canonical session row is persisted with the final state. Backward-compatible: older server builds that don't emit the field cause the desktop to silently skip the PATCH (status sync via `completeJob` still applies).

## [0.1.28] - 2026-05-01

Pipeline robustness: skill content reaches workers reliably (legacy seeds + 0-byte recovery), and Rust-created worktrees carry skills.

### Fixed

- **`/forge-*` slash commands silently broken after a stale install.** Pre-guard builds (before the empty-body guard in `install_skill_from_strapi`) wrote 0-byte `~/.config/forge-beta/skills/<name>/SKILL.md` files when the server returned an empty `skillMd`. Subsequent syncs short-circuited on hash equality and never re-fetched, leaving the local files broken until a manual reinstall. The desktop now also verifies the on-disk body is non-zero before honoring the hash match — empty files trigger a fresh install on the next sync, and the install path's existing guard rejects subsequent empty payloads. Older builds without the new `library_skill_body_ok` command fall back to the original behavior.
- **Empty `skillMd` returned by `/projects/:id/skills/effective` for legacy skills.** Skills seeded before v0.1 only have the `prompt` column populated; `skillMd` is NULL. The endpoint now falls back to `prompt` when `skillMd` is empty and recomputes `contentHash` from the effective body so cached legacy hashes don't pin the desktop on a 0-byte install.

### Added

- **Skills auto-copy into Rust-created worktrees.** `.claude/skills/` is gitignored in most forge projects, so `git worktree add` would otherwise drop a fresh worktree without any `SKILL.md`. The desktop now copies `<repo>/.claude/skills/` into the new worktree right after `git worktree add` succeeds (manual chat sessions that opt into worktree mode). Pipeline-driven sessions still run in the main checkout — the agent owns worktree creation through SKILL.md instructions.

## [0.1.22] - 2026-04-29

Patch: self-heal stale `config.coreUrl` for users who logged in before v0.1.21 on subdomain-split deploys.

### Fixed

- **"Sync to server" 404 after login.** Users who logged in on <= v0.1.20 stored the WEB URL in `config.coreUrl`. On subdomain-split deploys every subsequent `/api/*` call hit the web origin and 404'd (project save, agent run, etc. all silently failed). The desktop now resolves `config.coreUrl` via `/.well-known/forge-config.json` on every launch and persists the corrected value — single-origin deploys are unaffected, subdomain-split stale configs heal silently on first launch of v0.1.22.
- **CORS for Tauri webview** (server-side, ships with the next core deploy). The API now allows `tauri://localhost` (macOS/Linux) and `https://tauri.localhost` (Windows) unconditionally so desktop fetches with credentials succeed.

## [0.1.21] - 2026-04-29

Patch release: fixes the desktop "Server URL" field showing `http://localhost:8080` instead of the saved server URL.

### Fixed

- **Server URL field stuck on localhost.** A `useState` initializer captured the empty initial Zustand state before `useLocalConfig()` finished reading `~/.config/forge-beta/config.json`. The field now syncs once when the disk config arrives (guarded so it doesn't clobber any URL the user is already typing). Workaround on v0.1.20 was to retype the URL into the field manually.

## [0.1.20] - 2026-04-29

Patch release: server URL discovery so the desktop app's "Server URL" field accepts the same web URL the user uses in their browser, even on subdomain-split deploys (web + API on different hosts).

### Added

- **Server discovery via `/.well-known/forge-config.json`.** The Tauri client now probes this endpoint on the user-typed URL to learn where the API actually lives, following Matrix's [Client-Server discovery pattern](https://spec.matrix.org/latest/client-server-api/) (RFC 8615). Web app exposes the endpoint with `{ apiUrl, wsUrl?, version }`. Single-origin deploys keep working with zero configuration — discovery returns the same origin. Subdomain-split deploys (web at `forge-beta.sidcorp.co`, API at `forge-beta-api.sidcorp.co`) are now seamless: user types the web URL they see in their browser, app silently routes API calls to the right host.
- **"Server URL" field helper** on the desktop login form: "The same URL you use to open Forge in your browser." Removes the previous footgun where a user typing the web URL on a subdomain-split deploy would see the social-login section silently disappear because `/api/*` 404'd on the web origin.

### Fixed

- **Sign-in-with-GitHub button missing on subdomain-split deploys.** Root cause was the same as the bug fixed by the discovery endpoint above — the desktop app blindly appended `/api/*` to the user-typed URL, which only worked on single-origin deploys.

## [0.1.19] - 2026-04-29

Feature release: Sign in with GitHub / Google / OIDC on the desktop app, plus email-verification UX polish.

### Added

- **Desktop OAuth (ADR 0017).** New "Continue with GitHub" / Google / OIDC buttons on the Tauri login page. Click opens the system browser to the existing web OAuth flow; after the user authenticates, the browser deep-links back into the app via the new `forge-beta://` URL scheme and the desktop trades a one-time code for a JWT. The flow uses RFC 8252 (OAuth 2.0 for Native Apps) + RFC 7636 (PKCE) — the JWT never appears in any URL, never persists to disk, never embeds in the binary, and a malicious app intercepting the deep-link gets only a useless one-time code. Provider list is fetched dynamically from `/api/auth/oauth/providers`, so adding Google later is purely a backend config change. Gated behind `FEATURE_DESKTOP_OAUTH` on the core service.
- **`forge-beta://` URL scheme registration.** First launch of v0.1.19 (or first install on a fresh machine) registers the URL scheme with the OS — Info.plist on macOS, NSIS hook on Windows, `.desktop` file + runtime fallback on Linux. The OS may prompt for permission the first time the deep-link is invoked.
- **Single-instance plugin.** A click on `forge-beta://...` while the app is already running now wakes the existing window instead of spawning a new process — required for the OAuth handoff to land in the user's authenticated context.

### Fixed

- **Email verification link UX.** Clicking the verification link in the registration email now lands on the web `/login?verified=1` page with a green "Email verified" banner instead of raw JSON. Stale or expired links land on `/login?verify_error=…` with a friendly warning. Also fixes a bug where, on subdomain-split deploys (web + API on different subdomains), the verification link was generated against `APP_BASE_URL` (the web origin) and 404'd because `/api/auth/verify` only exists on the API origin — the link is now built against `OAUTH_REDIRECT_BASE` (the API origin) when set.

## [0.1.18] - 2026-04-28

Patch release: macOS auto-updater payload + Next.js DoS hardening.

### Fixed

- **macOS auto-updater entries.** `bundle.targets` was missing the `app` entry, so Tauri built `Forge Beta.app`, wrapped it in the `.dmg`, then deleted the `.app` directory before the updater could tarball it. Result: `latest.json` shipped with `linux-*` and `windows-*` keys but no `darwin-aarch64` / `darwin-x86_64`, which silently disabled in-place updates for macOS users. Adding `"app"` produces both `Forge Beta.app.tar.gz` and `Forge Beta.app.tar.gz.sig`, which tauri-action then attaches to the release and references from `latest.json`.

### Security

- **Next.js 16.1.7 → 16.2.4.** Closes [GHSA-q4gf-8mx6-v5v3](https://github.com/advisories/GHSA-q4gf-8mx6-v5v3) (DoS via Server Components, high). The advisory has separate fix lines per minor: 15.5.15 for `15.x` and 16.2.3 for `16.x`. The earlier 16.1.7 bump only crossed the 15.x boundary in the metadata; 16.x callers stayed below the patch. Open Dependabot alert count: 4 → 3 (remaining are transitive Rust deps `rand` and `glib` whose fix lines are above what Tauri's gtk-rs chain currently exposes).

## [0.1.17] - 2026-04-28

Rebrand to `Forge` under the `SidCorp-co` org **and** the first release to actually attach desktop installers to the GitHub Release. Every prior tag from `v0.1.9` onward built only the raw `forge-beta` binary because `bundle.active` was missing from `tauri.conf.json`; this release restores the bundler pipeline end-to-end. See ADR 0015 for the rebrand rationale.

### Changed

- **Repo URL:** `https://github.com/SidCorp-co/forge` (old URL auto-redirects).
- **Workspace layout:** `forge/<pkg>/` → `packages/<pkg>/` for `core`, `web`, `dev`, `app`, `contracts`, `tests`, `widget`. npm scope `@forge/*` is unchanged.
- **Tauri identifier:** `co.sidcorp.forge-beta`. The auto-updater endpoint in `tauri.conf.json` now points at the new repo.
- **Tauri config:** `bundle.targets` set explicitly to `["deb", "appimage", "dmg", "nsis"]`; RPM intentionally dropped because the GitHub-hosted Linux runner has no `rpmbuild`. `$schema` switched to the canonical `https://schema.tauri.app/config/2`. `bundle.publisher`, `category`, `shortDescription`, `copyright` populated for installer metadata.
- **Icons:** regenerated the icon set with `pnpm tauri icon`. macOS DMG now has the required `.icns`; Linux desktop entries get the proper 32/128/128@2x PNGs.
- **CI:** workflow declares `permissions: contents:read, pull-requests:read` so Dependabot PRs no longer fail at the changes job. New `dev-bundle-smoke` job runs `pnpm tauri build --bundles deb` (with a throwaway updater key) on PRs that touch `packages/dev/src-tauri/**` or `release.yml`, so a future `bundle.active=false` regression fails in CI rather than at tag time.
- **Docs:** trimmed `architecture/websocket.md` (678 → 167 lines), `modules/issues-pipeline/status-pipeline.md` (367 → 177 lines); maintainer-only artifacts (release tests, migration audits, ops runbooks) moved to gitignored `.internal-docs/`.
- **Dependabot:** `npm` ecosystem now scans only the active workspace members (`packages/app/` excluded per ADR 0009); `cargo` ecosystem added for `packages/dev/src-tauri/`.
- Internal hostnames + emails scrubbed from tracked sources (test fixtures, code comments, deployment defaults).

### Fixed

- **Bundler pipeline.** `tauri.conf.json` was missing `bundle.active`. Tauri 2 defaults that field to `false`, so `tauri build` produced only the raw `forge-beta` executable and skipped every installer. tauri-action then aborted with `No artifacts were found.` This was a silent regression: every release `v0.1.9..v0.1.16` shipped with empty installer attachments and the source-code zip only.
- **macOS codesign on unsigned builds.** The release workflow forwarded `APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}` even when the secret was unset; GitHub Actions interpolates that as the empty string, and Tauri's macOS bundler treats present-but-empty as "import this cert" and aborts with `failed to run command security import`. Same shape on Windows. The `APPLE_*` and `WINDOWS_*` env entries are now omitted entirely until real certificates exist; until then bundles ship unsigned.
- **release.yml runner detection.** Pinned `tauriScript: pnpm tauri` so tauri-action stops falling back to `npm run tauri` when `projectPath` (`packages/dev/`) has no `pnpm-lock.yaml` of its own.
- **pre-push guard.** Hook now fails the push if `bundle.active` ever drifts back to `false`, so the bundler regression cannot recur.
- **pre-push path.** Earlier hook used `$repo_root/forge/$pkg` as the package path — the variable substitution slipped past the workspace rename and the gate was effectively a no-op for any push touching the renamed packages until corrected.

### Security

- 6 cargo bumps merged through Dependabot (rustls-webpki, openssl chain via the minor-and-patch group, sha2, nix, tar, plus the Tauri 2.10.3 group). Open Dependabot security alert count: 44 → 33.

> ⚠️ **Breaking for installed alpha users:** the Tauri bundle identifier changed (`com.thejunix.forge-beta` → `co.sidcorp.forge-beta`), so the OS treats v0.1.17 as a different application from any earlier install. Reinstall is required; OS keychain entries are not inherited. In practice no installer was actually published for any tag prior to v0.1.17, so the population this affects is "people who built locally and ran it."

## [0.1.16] - 2026-04-28

OSS launch prep. Tags `v0.1.6` through `v0.1.15` were created during pipeline debugging and never produced a non-draft release. (At the time this entry was written we believed `v0.1.16` was the first version producing installable artifacts; that turned out to be wrong — the bundler was silently disabled until `v0.1.17`. See the v0.1.17 "Fixed" notes.) Desktop binary version realigned from the legacy `0.2.x` `forge-beta` train back to the repo's `0.1.x` line so tag, package, and Cargo versions match.

### Added

- Release pipeline now produces signed (where secrets are configured) macOS, Windows, and Linux artifacts on every `v*.*.*` tag.
- Per-package READMEs for `packages/dev`, `packages/contracts`, and `packages/app` (with paused-per-ADR-0009 banner).
- Conditional Apple Developer ID + Windows code-signing env in `.github/workflows/release.yml`. Builds remain unsigned (and installable with one-time OS warnings) until the optional `APPLE_*` / `WINDOWS_*` secrets are set; see [`docs/guides/release.md`](docs/guides/release.md) for the playbook.
- `NEXT_PUBLIC_APP_URL` in `packages/web` drives canonical / OpenGraph URLs on `/download` instead of a hardcoded staging origin.
- `packages/core` `dev` and `start` scripts auto-load `.env` via `--env-file-if-exists`.
- OAuth/OIDC keys (`GITHUB_OAUTH_*`, `GOOGLE_OAUTH_*`, `OIDC_*`) documented in `packages/core/.env.example`.
- `Apache-2.0` license declared explicitly on every workspace package.

### Changed

- Desktop binary version realigned: `packages/dev/package.json`, `tauri.conf.json`, and `Cargo.toml` all on `0.1.16` (was `0.2.27` / `0.2.27` / `0.2.4` — three-way drift).
- `packages/web` README rewritten from the default `create-next-app` boilerplate to a Jarvis-specific guide.
- `packages/dev/CLAUDE.md` updated to past-tense Strapi removal and "Forge core API client" naming.
- `/download` Quickstart Step 2 now walks through self-hosting (`docker compose up`) instead of pointing at an internal staging instance.

### Fixed

- `release.yml` failed every build at `pnpm/action-setup` because pnpm version was specified twice (`version: 9` + `packageManager` in `package.json`). Removed the explicit version.
- `release.yml` `cache-dependency-path` pointed at non-existent `packages/dev/pnpm-lock.yaml` — fixed to root `pnpm-lock.yaml`.
- `release.yml` ran `pnpm install` in `packages/dev` (workspace member, no own lockfile) — moved to repo root.

### Security

- Real-looking GitHub OAuth credentials removed from on-disk `packages/core/.env` (file deleted; gitignored, never in git history). Rotate the OAuth App secret at github.com/settings/developers as a precaution.

## [0.1.5-beta] - 2026-04-27

First end-to-end autonomous pipeline run on packages/core staging. Beta build
ships side-by-side with the legacy `forge-dev` binary so PMs can dogfood
without losing the production fallback.

### Added

- `forge_issues` + `forge_comments` MCP tools (ISS-293 chunk A) — port the
  legacy Strapi MCP shape; existing `/forge-*` skills work unchanged.
- `forge_config` + `forge_tasks` MCP tools (ISS-293 chunk B) — completes the
  toolset that `forge-plan`/`forge-code`/`forge-review`/`forge-fix` need.
- packages/dev `job.assigned` WebSocket handler (ISS-279) — receives dispatcher
  events, resolves project, spawns Claude CLI with `/forge-<type>` prompts,
  and posts events back to `/api/jobs/:id/events`.
- Stuck-dispatched watchdog (ISS-281) — cron every minute marks jobs that
  never reported `started_at` within 5 min as failed and schedules retry up
  to `maxAttempts`.
- JWT auto-refresh on 401 (ISS-280) — packages/dev API client clears the
  in-memory token and bounces to `/login` on `INVALID_TOKEN`/`UNAUTHENTICATED`.
- Pair flow auto-creates a `claude-code` runner row bound to the new device
  (post-ISS-271 dispatcher needs this to select the device for jobs).
- Inline "Pair Device" card in forge/beta Settings — temporary UX while the
  web pair-code page (ISS-211) remains backlog.
- Issue extension columns `plan` / `acceptance_criteria` / `suggested_solution`
  / `session_context` (migration 0032) — fields the autonomous pipeline
  persists across plan → code → review.

### Changed

- packages/dev binary renamed `forge-dev` → `forge-beta`. New install path,
  config dir (`~/.config/forge-beta/`), keychain service, Vite port 1421.
  Allows coexistence with the stable build during the v0.1 dogfood window.
- Tauri MCP config now sends `Authorization: Bearer <device-token>` instead
  of the legacy `X-Forge-API-Key` header — matches packages/core's
  `requireDevice()` middleware.
- Dispatcher `job.assigned` event includes top-level `issueId` (was only
  inside `payload`, but skill prompt builders need it directly).
- Device heartbeat now also refreshes any runner rows bound to the device,
  so the post-ISS-271 dispatcher does not flip them offline while the JS
  Tauri client does not yet drive `runner:register` over the Rust WS path.

### Fixed

- Skill installer wiped existing `SKILL.md` when the server returned an empty
  body (ISS-292 follow-up). Both layers (TS skill-sync + Rust install
  command) now refuse empty input — defence in depth so a malformed
  `/skills/effective` payload cannot silently break every `/forge-*` command.
- `/api/jobs/:id/events` 500 from `FOR UPDATE` on aggregate. Use
  `pg_advisory_xact_lock(hashtext(jobId))` to serialize concurrent inserts.
- `/api/jobs/:id/events` returning 401 INVALID_TOKEN despite a valid device
  token — per-handler auth scoping (was greedy `.use('*')` on a sibling router
  intercepting POSTs aimed at `requireDevice()`).

### Security

- WebSocket auth on packages/core accepts a device principal via
  `Authorization: Bearer` (Tauri Rust path) or `?token=` URL query (browser
  fallback). The query-token surface is a short-term workaround tracked under
  ISS-286 — migration to `Sec-WebSocket-Protocol` planned for v0.1.6.

## [0.1.1] - 2026-04-26

Patch release that ships the long-deferred landing-page GSAP fix from ISS-269.

### Removed
- `gsap` dep + `packages/web/src/lib/gsap-client.ts` + `packages/tests/web/lib/gsap-client.test.ts` — replaced animation usage with framer-motion (already a dep)

### Fixed
- Landing page `_gsap` undefined TypeError eliminated (ISS-269) — 3 prior fix attempts (rc.7 / rc.8 / rc.9) couldn't unblock Next.js 16 chunk-init race; swapping the 4 landing impl files to framer-motion's `whileInView` + `viewport={{once:true}}` pattern removes the class of bug entirely. -319 lines net.

## [0.1.0] - 2026-04-26

First v0.1 stable cut covering Phase 3.1 → 3.5 of the Strapi → `packages/core`
control-plane migration: UI batch + cleanup, Tier A LIVE features, Tier B1
medium ports, Tier B2 heavy/realtime ports, and Phase 3.5 FE wireup that
connects 13 placeholder/missing surfaces to the ported endpoints. `forge/strapi`
removal landed earlier in 0.1.0-rc.x; this release brings parity for the routes
the web + dev clients call and ships a fully functional UI on top of them.

E2E walkthroughs across cycles 1–5 (`docs/release-tests/v0.1.0-stable-ui-ux.md`)
verified the 19 ported product surfaces. Landing-page GSAP animation issue
(ISS-269) deferred to v0.1.x as cosmetic-only.

### Added
- Issue detail page: status transition dropdown + comment editor + live comments list backed by `GET/POST /api/issues/:id/comments` (ISS-247)
- Issues list: search box + status / priority filters with URL + project-scoped localStorage persistence; `<Suspense>` boundary added (ISS-248)
- Markdown rendering for issue description via shared `<Markdown>` component (ISS-249)
- `displayId` (`ISS-N`) badge on kanban cards (ISS-251)
- Static built-in domain template catalog at `@forge/contracts/domain-templates` (replaces Strapi `/domain-templates` fetch — see Removed)
- WS infrastructure: `userRoom(userId)` helper + `canSubscribe` gate for `user:` rooms, with prefix-isolation tests (ISS-258)
- `/api/notifications` full surface: list (paged, project filter, unread-only), `unread-count`, `mark-all-read`, `PATCH :id`, `DELETE :id`, server-side `createNotification()` helper, `notificationCreated` + `notificationRead` hooks bridging to `userRoom` (ISS-258)
- `packages/web` + `packages/dev` notification stubs re-enabled against the live `/api/notifications` endpoint; bell components updated to flat shape (`n.id`) (ISS-258)
- `/api/agents` CRUD: project-scoped list with `type`/`enabled` filters + `X-Total-Count`, create/get/patch, owner|admin-gated delete. Folds the legacy `agent-definition` template into the agent row (no template inheritance). Migration `0021_agents` (ISS-258)
- `/api/chat-sessions` CRUD with strict user-ownership gate + `POST /:id/message` (folds legacy top-level `POST /chat`): persists user message, broadcasts `chat.message` on `user:<id>`. **Streaming LLM reply deferred to a follow-up** (provider call + tool execution + streamed assistant reply requires the chat-prompt-builder + agent-runner services not yet in `packages/core`). Migration `0022_chat_sessions` (ISS-258)
- `/api/agent-sessions` full surface: CRUD (list takes `projectId` or `deviceId` scope), `POST /desktop/status`, `POST /:id/relay`, `GET/POST /:id/pipeline-control`, `GET/POST /:id/pipeline-telemetry`. WS broadcasts to both `device:<id>` and `project:<id>` rooms on create / status change / relay / control / telemetry. Migration `0023_agent_sessions` (ISS-258)
- `GET /api/issues/:id/cost-summary` (mounted on `issueExtrasRoutes`): joins `usage_records.session_id ↔ jobs.id` for an issue and returns rolled-up estimated cost + token totals + sample count (ISS-258 bonus)

### Changed
- Pipeline `STEP_LABELS` reflect the post-`clarified` flow: dropped `confirmed→clarified` + `clarified→waiting`, added `testing→tested`, `tested→pass`, `pass→staging` (ISS-244 #2)
- Project settings `STEPS` array drops the dead `autoClarify` step; `autoPlan` / `autoTest` status hints updated to match (ISS-244 #3)
- Kanban `pass` chip color: `bg-emerald-500/20 text-emerald-300` → `bg-green-500/30 text-green-200 font-medium` so it is distinguishable from `tested` (ISS-244 #4)
- Closed kanban column visible by default (`DEFAULT_VISIBLE.closed = true`) so closed issues stop disappearing (ISS-246)
- Login form validates with zod messages instead of HTML5 `required` (ISS-252)
- Register submit button: `bg-on-primary text-white` → `bg-primary text-on-primary` (fixes white-on-white contrast) (ISS-250)
- `notificationApi.getAll` / `unreadCount` (packages/web) drop the dead `?projectSlug` query param: the core schema only accepts `projectId: z.uuid()`, so the param was being silently dropped server-side. Per-project scoping now requires resolving slug → projectId client-side (TODO inline) (ISS-258)

### Removed
- Wired-but-dead pages `/antigravity` and `/cloudflare` (UnimplementedBanner stubs) + matching CEO sidebar links (ISS-255 §B / audit Table B)
- `packages/web` Strapi-flavoured `/domain-templates` fetch in chat-agent settings; replaced by `@forge/contracts` static catalog
- All callers of schema-only Strapi entities verified absent in `packages/web` + `packages/dev`: `agent-definition`, `app-config`, `audit-log`, `claude`, `claude-proxy`, `eval-run`, `heartbeat` (the Strapi entity — distinct from the project-config heartbeat field), `retrieval-analytic`, `skill-eval`, `token`, `user-preference` (audit Table C, ISS-255 §B)

### Fixed
- `/notifications/*` API client (web + dev) short-circuits to empty/no-op responses while the endpoint is unported in `packages/core`; eliminates 1–4 console errors per page navigation (ISS-253)

### Deferred to v0.1.x (tracked in ISS-259)
- Chat: streaming LLM reply on `POST /chat-sessions/:id/message` (needs chat-prompt-builder + agent-runner services ported to core)
- Agent-session: pg-boss-backed pipeline-control queue worker (current jsonb storage + WS broadcast is the wire-compatible interim; queue dispatch can be added additively without changing the request shape)
- Agent-session interactive UI (start/send/abort) — Tier B2 phase 4 ported the read-only viewer + WS broadcasts; interactive endpoints await core dispatch surface
- `notifications.agent_session_id` FK constraint to `agent_sessions(id)` with `ON DELETE SET NULL` — additive migration when the next schema change lands
- `UnimplementedBanner` audit pass on `packages/web/src/` (≈25 inline banners remain post-Phase-3.5)
- Per-project notification scoping (FE slug → projectId resolution to drive `?projectId=` filter)
- mark-all-read bulk WS emit (Lapras review minor #1 — currently single update bypasses per-row WS broadcast)
- ~~Landing GSAP `_gsap` TypeError (ISS-269)~~ — **shipped in v0.1.1**, see below.

### Security

## [0.1.0-rc.5] - 2026-04-25

### Added
- Branded 404 page (`packages/web/src/app/not-found.tsx`) with "Back to projects" CTA (ISS-243 #7)
- `NOTIFICATIONS_ENABLED` feature flag in `packages/web/src/features/notification/` to gate UI until backend ships (ISS-243 #1)

### Changed
- Web `IssueStatus` union + Kanban column constants synced to canonical `packages/core/src/db/schema.ts` 16-status enum: dropped `draft`/`clarified`, added `tested`/`pass` (ISS-242)
- Sidebar "+ New Project" CTA now opens the create-project modal at `/projects?new=1` (was dead-link to `/dashboard`) (ISS-243 #5)
- `/dashboard` wrapped in `<Shell>` for layout parity with other top-level routes (ISS-243 #3)
- New-issue form: empty submit now shows inline `Title is required.` error (was silent no-op) (ISS-243 #6)
- `/projects` empty/error: 401/403 surfaces sign-in CTA; other errors render `<AlertBanner>` instead of red text line (ISS-243 #4)
- `docs/architecture/system-overview.md` rate-limit blurb reconciled with `packages/core/src/config/rate-limits.ts` (5 / 15 min) (ISS-243 #8)

### Fixed
- `forge_auth` cookie now sets `Secure` in `staging` + `production` (was missing in `staging` because predicate compared `=== 'production'`) (ISS-240)
- Removed Strapi-flavoured `/api/notifications/unread-count` polling generating 404 every 30s (ISS-243 #1)
- Removed Strapi-flavoured `/api/user-preferences?filters[userKey][$eq]=...` calls; theme persists via next-themes localStorage only (ISS-243 #2)

### Validation
- ISS-238 `/ws` 404 confirmed false positive: after enabling Cloudflare Network → WebSockets, full handshake returns `101 Switching Protocols` with auth cookie (verified 2026-04-25)

## [0.1.0-rc.4] - 2026-04-25

### Added
- `GET /api/projects/:id/issues/by-display/:displayId` — resolve issues by `ISS-N` for shareable deep-links (ISS-241)
- Issue detail page accepts both `documentId` and `displayId` URLs; comments + activity section shells (ISS-241)
- `infra/nginx/stg-jarvis-a2.thejunix.com.conf` snapshot + `infra/nginx/README.md` 4-layer WS verification recipe (ISS-238)
- `docs/architecture/websocket.md` — Edge / reverse-proxy requirements section (CF zone-level WS toggle, HTTP/1.1 negotiation note)

### Fixed
- Issue list rows are now real `<Link>` anchors with displayId in href; right-click + open-in-new-tab work (ISS-241)
- Sidebar identity pill reads `user.email` (was hardcoded fallback `'Agent User'` because contract has no `username` field) (ISS-239)
- `/register` form: removed dead `username` input that was ignored by the API (ISS-239)
- nginx `/ws` location hardened with `X-Forwarded-*` + long timeouts + `proxy_buffering off` (ISS-238)

### Validation
- ISS-238 `/ws` 404 confirmed false positive at the routing layer: curl HTTP/2 returns 404, but RFC-compliant clients (browsers, `ws` npm) negotiate HTTP/1.1 and reach origin → 401. Acceptance still requires Cloudflare Network → WebSockets toggle to be enabled at zone level.

## [0.1.0-rc.3] - 2026-04-25

### Added
- `POST /api/auth/dev/force-verify` (dev/staging only, ADMIN_EMAILS-gated) — unblocks QA on no-SMTP deploys per ISS-235 item H
- `packages/web/src/app/projects/page.tsx` — projects list page accessible from post-login nav (ISS-235 item I)
- WebSocket upgrade auth: `forge_auth` cookie (user) or `Authorization: Bearer` (device); 401 on missing/invalid; room subscribe gated by principal (ISS-235 item B)
- pnpm overrides for React types — fixes web build with next-themes (ISS-235 item A)

### Fixed
- `NODE_ENV` enum accepts `staging` (was: development|test|production)
- Logger uses pino-pretty only in NODE_ENV=development; staging/prod emit JSON for parity + runtime image compat
- docker-compose.prod.yml NODE_ENV now overridable via .env

### Validation
- E2E test report: `docs/release-tests/v0.1.0-rc.2-staging.md` (ISS-236)
- Bug #1 from rc.2 report (`/ws` 404) confirmed false positive — WS works through CF + nginx

## [0.1.0-rc.2] - 2026-04-24

### Fixed
- `docker compose up` now works out of the box: `core` service receives full env via `env_file: .env`
- pg-boss v10: explicit `boss.createQueue()` before `work()`/`schedule()` (jobs dispatcher, jobs/devices stale detectors, JobEvent retention sweeper, webhooks outbound)
- Core Dockerfile runs migrations programmatically at startup (`dist/db/migrate.js`); no `drizzle-kit` needed in runtime image
- Web Dockerfile rewritten to use pnpm + workspace context (npm ci can't resolve `workspace:*` for `@forge/contracts`)
- SMTP env vars now optional: when `SMTP_HOST` is empty, email send is skipped (logged instead). Email verification still enforced server-side
- `APP_BASE_URL` and `CORS_ORIGINS` default to `http://localhost:3000` when unset
- Broken `[ROADMAP.md](ROADMAP.md)` link in `docs/architecture/system-overview.md` (resolved to `../ROADMAP.md`)
- Added `docs/rfcs/0001-device-runner-architecture.md` stub (canonical content remains in ADR 0001)
- Test mocks updated for pg-boss `createQueue` API
- `pipeline-e2e.test.ts` multi-line `typeof import(...)` syntax (TS 5.7 strict)

## [0.1.0-rc.1] - 2026-04-24

### Added
- `packages/core` control plane: Hono + Drizzle + pg-boss + `ws` + MCP server at `/mcp`
- Dual-principal auth (user JWT + device token) with shared policy layer
- 14-status issue pipeline with WebSocket room-scoped broadcasts
- Device pairing: Tauri `dev` GUI + `forged` CLI daemon, shared Rust `agent-core` crate
- Session replay with 30-day JobEvent retention after terminal state
- `pgvector` memory store with HNSW index on `vector_cosine_ops`
- Email verification gate at first-project creation
- Apache-2.0 license; initial public release scaffolding
- Four clients: Next.js web, Tauri desktop, React Native (Expo) mobile (paused), and `packages/core` API

### Changed
- Control plane rebuilt on Hono + Drizzle, replacing the former Strapi backend (ADR 0002, ADR 0010)
- Vector storage moved from Qdrant to Postgres `pgvector` (ADR 0011)
- Postgres image upgraded to `pgvector/pgvector:pg17` in both dev and prod compose, and in the CI e2e-web service
- WebSocket broadcasts changed from global fan-out to room-scoped (`user:<id>`, `project:<id>`, `device:<id>`)
- All clients (web, dev, app) repointed from `http://localhost:1337` to `http://localhost:8080`
- `packages/app`: `strapiMediaUrl` helper renamed to `mediaUrl`

### Deprecated

### Removed
- `forge/strapi/` package (archived to `legacy/strapi-v0` tag)
- `qdrant` service from `docker-compose.yml` and `docker-compose.prod.yml`
- `crossProjectAccess` MCP flag — every MCP tool call now requires `projectId` and passes the policy check
- `forge/test-flow.sh` legacy integration script
- `packages/tests/strapi/` test suite
- Strapi-specific env vars: `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY`, `STRAPI_URL`, `STRAPI_TOKEN`

### Fixed

### Security
- All five findings from the 2026-04-19 architecture audit closed by construction in `packages/core` (see ADR 0001 §Context and the release-specific audit closure doc at `docs/security/audit-v0.1.0-rc.1.md`): row-level access checks via shared policy layer, room-scoped WebSocket broadcasts, `crossProjectAccess` flag removed, JWT TTL reduced to 7 days with `httpOnly` refresh-token rotation, Claude credentials never held on the server (device-runner split)

---

<!--
Release workflow:
1. Every meaningful PR adds a line to [Unreleased]
2. At release time: rename [Unreleased] to [x.y.z] - YYYY-MM-DD, create a new empty [Unreleased]
3. GitHub Release notes are copied from the version section
-->
