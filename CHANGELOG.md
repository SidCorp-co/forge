# Changelog

> **Cutoff: 2026-08-28.** Nothing before that date is carried here. 1,034 lines were removed in
> `3df9a8e9`; the owner decided on 2026-08-31 not to restore them, and that decision stands rather
> than being revisited each time someone notices the gap. They are readable at
> `git show 3df9a8e9^:CHANGELOG.md`. Later cuts trim the same way: git is the record of what
> shipped, and this file is the short reader-facing view of the recent end of it.

## [Unreleased]


### Added

- **An agent working an issue on a project that keeps modules is now told they exist, and how to
  set the issue's primary one.** ISS-593 made a module a label with `kind='module'` and gave an
  issue a primary through `issue_labels.is_primary`, but nothing told the agents doing the work:
  the field was discoverable only by reading the `forge_issues` tool description closely, and no
  prompt anywhere said attributing was expected or which modules a project had. Projects that had
  a module convention carried it as a `**Module:**` line agents wrote into a comment — a tag no
  query could filter on.

  Every pipeline job for a project with at least one `kind='module'` label now carries a **The
  issue's primary module** section in its system prompt: the project's modules with their parents,
  the `{ labelId, isPrimary: true }` attach payload that sets the primary, and the explicit
  statement that a `**Module:**` comment is not the attribution and nothing reads it. It also says
  to leave the primary unset when unsure, because a wrong primary is worse than none — the module
  filters are counted from it.

  A project with no module labels gets no section at all, byte-for-byte as before: the taxonomy's
  existence is the only switch, and there is no setting to turn this on. Nothing is written by the
  server; Forge still never guesses an issue's module. Migrating a project that already has a
  module convention: `forge_guide get module-taxonomy-migration`. (ISS-595)

- **A project's owner can set a standing policy for its master, and it survives the session.**
  The forge-dev master ran on an instruction — an advisory session budget, which issues count as
  eligible, when to group work into one session, what to pay down alongside the change — that
  existed only as text a human had typed into a tmux pane. Every master restart dropped it, and it
  was re-sent by hand twice and lost twice in two days. Nothing in the master's own process could
  hold it: the skill text ships inside the runner binary, so an edit needs a release, and the two
  places it does discuss batch size and grouping said the opposite of what the owner had decided.

  A project now carries a `master-policy` fact (set it with `forge_config`, no deploy and no
  restart). Core sends it on `/me/runners` as `masterPolicy`, the daemon splices it verbatim into
  the standing brief the master is given once per session, and the brief says plainly that it
  outranks the shipped skill wherever the two differ. The skill's *Deciding how many* and grouping
  sections now defer to it and keep their own text as the default for a project that has set none —
  a project with no policy is briefed byte-for-byte as it was before. Reaching the fleet needs a
  `runner-v*` release. (ISS-929)

- **A master that cannot start is stopped being restarted, and a fresh box never meets the
  workspace-trust dialog.** `ensure_master` respawned a dead master on every 30-second sweep with
  nothing counting how many times it had already done so, so a session that died deterministically
  burned the box's core loop twice a minute while the project's pool sat unread. On forge-vm
  (2026-09-06) the deterministic death was Claude Code's workspace-trust prompt: it is shown in a
  TTY only, `-p` and the SDK skip it, and a resident master lives in a tmux pane — which is a TTY —
  so the pane held an unanswered prompt and ended. Two halves, both in the runner:

  Three master deaths inside ten minutes now stop the respawn for thirty, with a `DEGRADED` line
  per sweep naming the project, the tally and when the box will try again. The tally is per project,
  so one broken checkout cannot idle the others, and it is a backoff rather than a latch: after the
  cooldown the box tries exactly once, and a probe that dies re-opens it immediately instead of
  buying another run of three. An operator who repairs the box out of band gets that probe without
  restarting the daemon.

  And the runner now pre-accepts the trust dialog for the checkout it owns — at provision, where the
  box first takes the path, and again immediately before a master pane starts, which covers every box
  provisioned before this shipped. It writes `hasTrustDialogAccepted` into Claude Code's own config
  JSON, only when that path is not already trusted, atomically and keeping the file's mode; a config
  it cannot parse is refused rather than replaced. Reaching the fleet needs a `runner-v*` release.
  (ISS-928)

- **Project knowledge is searchable over REST, so a client that leaves MCP keeps the capability.**
  `POST /api/projects/:id/knowledge/search` takes `{query, topK?, scope?, strategy?}` — the
  `forge_knowledge` search action's own fields, defaults and bounds — and answers from the same
  `runUnifiedSearch` service, so the two transports cannot drift into different results. It is a
  `POST` because `GET` on that path is already the `/:slug` entry handler and answers *knowledge
  entry not found*, which is one of six paths ISS-930 probed live before filing. `sourceFilter` is
  deliberately absent: the MCP action never had one either, and that argument belongs to
  `POST /api/memory/search`. Member-gated, rate-limited at 60/min per user like memory search,
  because both spend on the same embeddings provider. (ISS-930)

- **An unattended agent session holds its own credential, and it dies when the session does.**
  A scheduled run, a RocketChat escalation and a RocketChat agent chat all open an agent session
  with nobody at the keyboard. Until now none of them had a credential of its own: the mint Forge
  already does for a dispatched job is keyed on a `jobs` row, and these have no job — so that whole
  caller class fell back to whatever long-lived token the box was provisioned with, which is exactly
  the credential nobody is watching. Core now mints a `session:<id>` PAT on `agent:start`, bound to
  the one project, scoped read+write, on the same measured 600/min ceiling a job token gets, and
  hands it to the runner on the dispatch frame as `$FORGE_PAT`.

  It is revoked from **both** writers that can end a session, which is the part worth reading. The
  kernel chokepoint covers cancel, the stale sweeper, a dispatch failure and a run-close cascade;
  the runner's own happy-path completion is a direct `db.update` in `PATCH /api/agent-sessions/:id`
  that the chokepoint never sees, and the guard test protecting that invariant cannot see it either,
  because it scans for a literal status and that handler writes a variable. Wiring only the
  chokepoint — which is what this change was originally specified to do — would have left a live,
  write-scoped, project-bound credential behind every session that finished normally.

  Interactive chat is deliberately excluded and keeps the operator's `$FORGE_PAT`. A chat turn
  reports `completed` at the end of every turn, so core's status vocabulary cannot tell a dormant
  session from a finished one; a token revoked on that ambiguity would be cut out from under a
  resident `claude` process that reads `$FORGE_PAT` once, at spawn. Unattended sessions are
  single-turn by construction, so for them terminal really is terminal. (ISS-927)

- **The Ops Console's alert thresholds are an operator setting, and spend has a ceiling.**
  `GET`/`PUT /api/admin/thresholds` (platform admins only) reads and writes one global row: the
  stuck-job window, the runner-starvation grace, the spend-spike multiple, the schedule fail-streak,
  the delivery fail-rate, the labels that count as an intervention, and how many days offline makes
  a runner a ghost. `computeAlerts()` re-reads the row on every call, so a change lands on the next
  sweeper tick with nothing restarted, and the three `FORGE_ALERT_*` environment knobs it supersedes
  were deleted rather than shipped beside it.

  `spendCeilingUsdDay` is new capability, not a rename: the spike alert compares one window against
  the one before, so a deployment burning the same large amount every day had a ratio of 1.0 and
  reported nothing. With a ceiling set, A4 warns at 80% of a trailing 24 hours and goes crit at the
  ceiling, and the alert says which of the two arms fired. The table ships empty and the declared
  defaults stand in, so a deploy that never writes it behaves exactly as it did before. (ISS-654)
- **GitHub is connectable from the UI.** The backend for the App-manifest flow shipped some time
  ago — three routes, an adapter, a signed connect state — and nothing ever called them. The web UI
  classified `github` as read-only telemetry, so the only GitHub affordance in project settings was
  a card showing a repo URL, and there was no path to a connection at all. Project settings →
  Integrations now opens a GitHub section that creates the App: pick an organization (blank for
  your personal account) and an environment, and Forge hands GitHub a manifest naming the
  permissions it asks for, which the screen lists before you leave. GitHub creates the App, the
  callback stores the credential, and you land on its install page to choose repositories.

  The handshake has one shape that must not be refactored away, and it carries a guard: the
  manifest goes to GitHub as a **top-level form POST**, never `fetch`. GitHub reads `manifest` from
  a form submission, and the redirect back to the callback authenticates on the `forge_auth`
  cookie, which is `SameSite=Lax` and so rides a real navigation and nothing else. A background
  request would resolve and connect nobody.

  A card that is drillable now shows **Manage** even when it also links out to the repository.
  GitHub is the first provider that has both, and the previous either/or would have left its card
  offering only the link that navigates away from the screen that connects the App.

  **One App serves the whole organization, not one per project.** The App is the credential; the
  repository a project uses belongs to that project's binding, and `owner`/`repo` were already
  declared binding-tier keys that nothing had ever filled in — which is why a per-project App was
  the only thing keeping two projects apart. A project that finds an App already connected now
  picks a repository from what that App's installations actually granted, and the binding records
  the repository and the installation that reaches it: no approval screen, no second private key,
  no second webhook secret. Creating a separate App stays one click away for the case that needs
  one, and the first connect asks whether the credential belongs to you or to the organization —
  org-owned requires org admin, the same gate the generic connection create applies.

- **`/admin` answers "who is using Forge, and what needs me right now".** The Operator Ops Console
  overview was an empty state; it now renders the deployment from the four `/api/admin/*` endpoints
  ISS-651 and ISS-652 shipped. A KPI row (open alerts, jobs in flight, active workspaces, spend this
  window against the window before), the A1-A5 alert feed sorted crit before warn before ok, five
  Tier 2 glance cards with a delta and a sparkline, the signup curve and the top-workspace table.
  Each of the four panels carries its own loading, error-with-retry and empty state, so one dead
  endpoint costs its card rather than the page.

  A stuck-job (A2) row carries a **Reap** control that confirms before it cancels. Making it work
  everywhere took two authz widenings outside `/api/admin/*`, both on the `ADMIN_EMAILS`
  allow-list: `POST /api/jobs/:id/cancel` falls back to the platform-admin check when project role
  is short — without it the button was dead on every tenant the operator is not a member of, which
  is most of them — and `canSubscribe` admits a platform admin to a `project:` WebSocket room on
  the same list, so the live half of the screen refreshes for all projects and not just the
  operator's own. The room widening is READ-only and says so in a guard: project rooms carry
  invalidation events and accept no input from a subscriber.

  The "Open alerts" tile read the alerts the feed below it was showing rather than
  `overview.kpis.openAlerts`, which was an independent A2-only approximation; ISS-654 unified the
  two and the tile now reads the KPI. Printing "0 - nothing needs you" above a red crit row is the
  one thing this screen must not do.

  The wire shapes moved to one declaration (`@forge/core/admin-types`, re-exported through
  `@forge/contracts`) instead of the two that were drifting, and the `overview` placeholder was
  deleted rather than left beside the screen that superseded it.

- **Settings → Pipeline edits the tool policy it has only ever displayed.** Since ISS-813 the tab
  has shown each stage's `disallowedTools` / `allowedTools` and its per-stage `mcpServers` — the
  policy the dispatcher hands every session — and offered no way to change any of it short of a
  REST call. Each stage now carries a draft editor: chips you can remove, a picker seeded from the
  ids the project already uses, a free-text field for one it does not, and catalog toggles for the
  per-stage MCP override. A stage with no override yet is listed too, so one can be added rather
  than only amended.

  Every save round-trips the full fetched config and overrides exactly one `states[<status>]` key,
  through a single writer (`withStagePatch`). That is not stylistic: `statesConfigSchema` has no
  passthrough and the PATCH replaces `states` wholesale, so a save built from anything less than
  the fetched map deletes the stages it omitted. Four tests fail if any one of its three spreads
  goes, including one asserting a key no schema version declares.

  Alongside it, `agentConfig.stateContext` — a model override and a spend cap per kind of job —
  becomes editable through the scoped `stateContext` field that already existed on
  `PATCH /projects/:id`. Budgets are all-or-nothing in the browser because core's `budgetSchema`
  is `.strict()` with all three keys required: a half-filled budget was never a smaller cap, it
  was a 400. No core changes were needed for any of this.

  Two of the five fields the issue asked for were refused by name rather than answered with the
  nearest thing that renders. `states[*].skipComplexities` was deleted from `stageConfigSchema` by
  ISS-897, and that schema strips unknown keys, so a control writing it would be undone by the
  next save; `recoveryMaxAttempts` / `recoveryWindowHours` / `recoveryByFailureKind` have no
  reader anywhere in core, so adding them to the schema would have made three dead dials
  configurable. The "configured elsewhere" list is rewritten to match: every row now names a key
  something in core actually reads, and none of them promises work to a closed issue.
- **Connecting GitHub is an authorization, not a form.** `POST
  /api/projects/:id/integrations/github/connect` returns an App manifest; the operator's browser
  posts it to GitHub, GitHub creates the App and redirects to
  `/api/integrations/github/manifest-callback` with a one-time code, and converting that code
  yields the App's `id`, `pem` and `webhook_secret` at once. Nothing is typed, so nothing can be
  mistyped, and the binding's `integrationSecret` is the App's own webhook secret rather than a
  freshly minted one that would fail every signature check while the UI showed the integration as
  configured.

  The `state` carried through the flow is HMAC-signed with a ten-minute life AND checked against the
  session on the way back: the signature proves Forge issued the state, not that this browser is the
  one that asked for it. Without the second check a signed state replays in someone else's session
  and binds an attacker's App to their project — which is what the test asserts, and it fails with
  `expected { projectId: 'p-attacker', … } to be null` when the signature check is removed.

  **The mount nearly shipped a 401 on every webhook.** The callback sub-app carried
  `use('*', requireAuth())` and mounts at the broad `/api` prefix, where Hono turns it into `/api/*`
  on the parent and runs it for every route registered afterwards — including the deliberately
  unauthenticated `/api/webhooks/in/:slug`. Measured before the fix: `POST /api/webhooks/in/demo` →
  `401 UNAUTHENTICATED`, so every GitHub delivery would have been rejected by a guard belonging to
  an unrelated feature while the integration still displayed as connected. The guard is now scoped
  to `/integrations/github/*`, and `middleware/route-mount-order.test.ts` carries both halves — the
  broad mount failing, and the scoped one leaving the webhook public. The `cm:edge lockstep` on that
  file is what surfaced it; it was one line of "advice, not a verdict" away from being dismissed as
  unrelated to a route mount.

- **GitHub is an integration provider, not a second webhook path.** It used to live on a branch
  inside `POST /in/:slug` keyed on `projects.webhookSecret` — one shared secret per project, no
  environment split, no delivery log, no health, no circuit breaker — kept, by its own comment,
  "preserved verbatim so the existing inbound-routes.test.ts regression test continues to pass".
  Measured on the live fleet 2026-09-06, that path had **0 of 41** projects configured and had
  produced **0 of 4,436** issues, so there was nothing in the field to keep working and the branch
  is gone rather than left beside its replacement.

  `github` is now a registered adapter with its own connection, binding, per-binding
  `integrationSecret`, delivery log and healthcheck, reached by `x-github-event` like any other
  provider. A delivery signed with the project's old `webhookSecret` is now refused — there is a
  test that asserts exactly that, because it is the break, and it fails with `expected 200 to be
  401` if the routing entry is removed.

  **The credential is a GitHub App, not a pasted token.** The app-manifest flow returns `id`, `pem`
  and `webhook_secret` to Forge's own redirect, so nothing is typed by hand; a repository call
  carries an installation access token minted from a JWT signed with that key
  (`POST /app/installations/{id}/access_tokens`, one hour, cached until five minutes before it
  lapses). The JWT backdates `iat` by a minute because GitHub rejects one issued in its own future,
  which a box with a slightly fast clock produces and which surfaces as an unexplained 401 on a
  credential that is fine.

  That App signs every installation's deliveries with **one** webhook secret, so a valid signature
  proves the App sent the event and says nothing about which binding it belongs to. The adapter
  therefore matches `repository.full_name` against the binding and refuses by name when they
  differ — without it, the router's "first binding whose secret verifies" would hand one repo's
  events to another's binding silently, behind a 200.

  Failures are told apart rather than collapsed into `needs_reauth`: 401 on the JWT is a wrong App
  id or key, 404 is an App that is not installed on that account, and 403 on the repository is an
  installation missing a permission — three different things for the operator to do. ISS-924 files
  the same mislabel against the Coolify adapter.

  Opening and reviewing pull requests is not in this change and is refused by name until it lands.

- **Modules: a taxonomy an issue can be filed under, and one primary module per issue.** A module
  IS a label — `labels.kind` is the only thing telling them apart — so every path that already
  attaches, filters and lists labels carries modules with no second table and no second attach
  path. Modules add `parentId` (a hierarchy, self-referencing) and `description`, and get a colour
  assigned when created without one.

  An issue's **primary** module is `issue_labels.is_primary` and nothing else: no column on
  `issues`, no separate row. Send it as `labels: [{ labelId: "<name or uuid>", isPrimary: true }]`
  alongside the plain strings both REST and `forge_issues` already took; a new primary replaces the
  old one inside the same transaction that rewrites the label set, so no caller clears the old
  designation first. At most one per issue, and it must be a module —
  `MULTIPLE_PRIMARY` / `PRIMARY_NOT_MODULE`, refused before anything is written, with
  `issue_labels_primary_uq` as the database's own backstop for a writer that bypasses the service.
  An existing label can be promoted to a module; demoting one back is refused while it still
  parents another module or is some issue's primary (`MODULE_IN_USE`), or while it carries a parent
  of its own (`PARENT_ON_NON_MODULE`) — none of the three has a database constraint that would
  catch it.

  Filter by it with `?module=<name|uuid>` on the issue search endpoint and `filters.module` on
  `forge_issues.list`. Both match MODULE labels only: the name of a plain label returns no issues
  rather than quietly behaving as `?label`, which stays uuid-only and unchanged. Every `labels[]`
  read now reports `kind` and `isPrimary` per entry (`ModuleAttribution` in `@forge/contracts`).
  Both database-level refusals (`issue_labels_primary_uq`, `labels_kind_chk`) are asserted by
  constraint NAME rather than by regex over the error message. Drizzle wraps the driver error, so
  `.message` carries only the failed SQL: the regex matched nothing, and each case was red whether
  the constraint existed or not — no signal in either direction. The name is green only when that
  constraint rejected, and red both when nothing rejects and when a different one does.

  Migration `0213` is additive in every statement — existing labels read back as `kind='label'`,
  existing attachments as `is_primary=false` — and carries `labels_kind_chk`, because
  `text(col,{enum})` is a compile-time type and emits no constraint of its own. Drawn in
  `docs/flows/issue-work-module-attribution.html`. (ISS-593)

- **`pnpm test:changed` — the local loop, wired to nothing.** Runs the tests a change reaches
  (`vitest list --changed` against the same `baseRev()` the drain gate uses, so a push straight to
  `main` does not select an empty diff) plus every test that scans the source tree rather than
  importing it. On a typical commit that is 125 of 447 core files in 41s, against 112s for the lot.

  The second lane is why this is a script and not a vitest flag. Measured 2026-09-06: the graph
  selection for `memory/knowledge-promotion.ts` is 3 files and misses `issues/one-create-path.test.ts`
  and `body/doors.test.ts` — the exact two gates that file's own commit had to edit, because they
  enforce an allowlist by walking the tree and nothing imports them into any graph. 14 such files in
  core, 2 in web, 4.5s for all of them. The lane is derived by scanning for that coupling, never
  kept as a list, so a tree-scanning test added later joins it the first time the command runs.

  It is deliberately not a gate: no entry in verify's `CHECKS`, no step in `ci.yml`, no line in
  `CI_COVERAGE`, and it prints that it is not a green on every run including a passing one. Over
  half a package's suite selected, it runs the whole suite instead and says so — a fast path that
  quietly becomes the slow one is worse than none.

- **Knowledge promotion is a per-project toggle, and its proposals now arrive as work.** The one
  automatic path from durable memory into the curated knowledge store ran on every project from a
  pg-boss cron with no switch, no row in the `schedules` table and no mention on any settings page —
  measured 2026-09-05, the fleet owner could not say what it was doing. It is now
  `pipelineConfig.knowledgePromotion`, absent means off, and Project settings → Pipeline carries the
  toggle plus the two numbers that set the rate (`candidatesPerRun`, `minRetrievals`), with the
  nightly hour and the capacity cost written on the panel rather than discoverable afterwards. Each
  proposal now names the config that produced it and where to turn it off.

  Proposals are filed at `open`, not `draft`. Of the 71 filed while it was silent, 8 were worked —
  5 of them on 2026-09-05, each verified against live code and written into `knowledge_entries` —
  and 63 sat until a sweep closed them, because a draft has no owner and nothing ages it. `open`
  auto-triages into a pipeline run, which is why the opt-in above ships off: on a project with a
  large eligible pool (1,014 memories fleet-wide met the bar) `candidatesPerRun` is the only bound on
  the first night.

  The code moved out of `memory/consolidation.ts` into `memory/knowledge-promotion.ts` — the file was
  at its frozen size budget, and the concern was never consolidation's. Two architecture gates
  (`one-create-path`, `body/doors`) named the old path and caught the move.

- The codemap baseline drains when a file is edited, not only when it is annotated (ISS-844). The
  gate froze 12,454 comments across 965 files at onboarding and then blocked only prose that was
  NEW; the one path by which the frozen total could fall was *siting* — prose sharing a block with a
  `cm:` annotation — which fires only when an author reaches for a tag. So a file could be
  refactored, extended and rewritten for years with its frozen count never moving, and codemap's own
  SPEC said as much in its own words: "Without this exception the baseline has no path that ever
  reduces". `CM013`, new in the vendored checker at 0.16.0, asks what siting cannot: this change
  altered what the file *does* and paid none of that file's frozen debt — why is the count still the
  same? Deleting or rewording one comment satisfies it.

  Reflow, rewrap, reindent, a repo-wide formatter run and a file move all cost nothing, and not by
  exemption: the rule compares the two revisions' code with comments stripped and whitespace
  normalized, and a move's new path has no baseline entry to drain. It never fires on a whole-tree
  run, which has no notion of "edited", nor in the mid-edit hook — the unit is a change, so the
  commit (`--staged`) and the PR (`--since`) are where it holds.

  **Priced:** a PR that edits one of those 965 files now owes one comment's cleanup in each. Measured
  on this repo's own recent history, a single-commit PR owes about 4 and a five-commit range about
  20. It ends at a file's zero. Per-file escape `cm:ignore CM013 — <reason>`, read from anywhere in
  the file; repo-wide `enforce.drain: false`. The rule itself is upstream in
  `SidCorp-co/forge-pipeline-skills` at `codemap-v0.16.0`, since that is where baseline behaviour is
  owned; here it is the pin bump plus `scripts/check-codemap-drain.mjs`, wired into `pnpm verify` and
  the `codemap` CI job.

- A memory body a later write replaced is kept and readable (ISS-790). After ISS-876 removed the
  dedup absorb, an exact-key re-write became the only path by which one memory row's text replaces
  another's — and it is the path both agent preambles instruct ("reusing a `sourceRef` refines the
  existing note"), while `archiveSupersededText`, the one thing that had ever recorded a
  replacement, went with the absorb. Nothing anywhere recorded the overwrite. A `memory_revisions`
  table (migration `0208`) now keeps the previous body, written by an `AFTER UPDATE` trigger rather
  than from TypeScript because `indexer.ts`, `consolidation.ts` and `chunk-reindex.ts` each rewrite
  `text_content` on their own path and a record wired into one of them misses the next writer added.
  Identical text records nothing, so the embedding backfill and `feedback` mint no history, and
  lifecycle mirrors (issue/comment/job/decision) are excluded — their text tracks a record that keeps
  its own. Read it at `GET /api/memory/revisions?projectId=…&sourceRef=…` or `forge_memory.revisions`.
  The four wrong-day rows repaired on 2026-09-05 were recoverable only because the deleted absorb had
  left archived snapshots behind; a repeat would have had nothing to read.

- Retrieval v3, phase 4 (ISS-907). Keyword search understands identifiers. `LITELLM_API` finds a memory
  that says `LITELLM_API_URL`, `cascade` finds `runs-cascade.ts`, `memory/rerank.ts` finds the full
  path, and `transition` finds `applyKernelTransition` — across memories, memory passages, knowledge
  entries and the issue search. One immutable Postgres function splits camelCase, `_`, `/`, `.`, `:`
  and `-` into words behind a generated `ident_search` column on the four tables (migration `0207`,
  which rewrites them once), and the keyword strategy matches English or identifier and ranks by the
  sum. Hybrid search now weights its two arms equally: at the old 0.7 / 0.3 a hit found only by the
  keyword arm could never reach the top 8 or the rerank pool, which is why identifier lookups landed
  in the top 8 on 20–53% of queries across six projects and land on 93–100% now, with no change to
  natural-language queries.

- `forge_issues list` accepts a `complexity` filter (ISS-912). The field was already returned by
  `get` and on every list row, but nothing could narrow by it: the filter was absent from the input
  schema and, once added there, still dropped by the hand-copied mapping into the list service — a
  filter that vanishes in that mapping returns every row, which reads as "nothing narrowed" rather
  than as an error.

- `forge-runner` 0.11.1. Carries the master's rate-limit backoff and the pre-spawn heartbeat fix.
  The claim floor stays at 0.11.0 — it is a per-feature floor naming the first build that can name
  its agent, not a "must be current" check, so this release does not strand anything.

- Retrieval v3, phase 2b (ISS-908). Project Settings gains a **Memory** tab. A project admin sees the
  project's memory model and, when it is flat, the estimate for switching to chunked (memories,
  characters, passages, embedding calls, minutes) with a *Switch to chunked* button. While the reindex
  runs the tab shows done / total with a progress bar and the last batch time, refreshing every five
  seconds, and offers *Cancel*; a failed reindex shows its error with *Retry*, a cancelled one its
  partial counts with *Resume*; a completed one offers *Switch back to flat* behind a type-to-confirm
  that names the seven-day purge. Members see the same state without the buttons.

- Retrieval v3, phase 2 (ISS-906). A project admin can move a project's memory onto the chunked model
  with `POST /api/app-config/:projectId/memory-model { model: 'chunked' }`, after reading
  `GET …/memory-model/estimate`. From then on every `issue`, `note`, `knowledge`, `decision` and
  `policy` memory is also stored as ~1,200-character passages with a context prefix in the new
  `memory_chunks` table (migration `0205`), and semantic and keyword search match on the passage,
  returning `matchedChunk: { index, text }` on the hit, so a fact buried in the last paragraph of a
  long issue is found instead of drowned by the document's head. Existing rows are re-embedded by a
  resumable background job whose state (`queued · running · completed · failed · cancelled`, with
  counts) is readable at `GET …/memory-model/reindex` and cancellable with `DELETE`; rows it has not
  reached yet are still searched the old way, so the flip has no gap. Flipping back to `flat` is
  immediate and purges the passages a week later. A rewrite during an embeddings outage never leaves
  the old passages searchable. `memoryModel` is no longer settable through `PUT /api/app-config`.
  The Project Settings card for the five states is ISS-908.

- Retrieval v3, phases 1 and 3 (ISS-905). On a project whose admin turned on `retrievalRerank`, an
  agent's `hybrid` memory search (MCP `forge_memory.search`, the chat toolset, `forge_knowledge`
  search) comes back in the order the fast model gives the fused candidates — `reranked: true`, a
  `rerankPosition` on every hit, `score` still the RRF value — and falls back to the RRF order without
  an error whenever the model answers with prose, an index out of range or nothing at all. One
  eligible search in five is a deliberate holdout so the pilot has a control. `POST /api/memory/search`
  is never reranked. On a project with `retrievalExpandRelations` on, a search whose hits include an
  issue appends that issue's unexpired `blocks` / `relates` neighbours after the ranked hits, marked
  `via` and scored 0. `RERANK_MODEL` optionally names a different model than `LITELLM_FAST_MODEL`.

- **A master agent can now take work from a pool, instead of core pushing it.** Four device-scoped
  endpoints under `/api/devices/me` — `pool`, `pool/claim`, `pool/release` and `load` — let a
  session running on a box read what work exists, take some, hand it back, and see how loaded the
  box, the project and the fleet are. `jobs.held_by` records who took a job; a `master-hold-reaper`
  sweep every minute returns the holds of any master that went terminal or stopped beating, which
  is what stops a master dying at 3am from parking work nobody can reach. The pool reports each
  blocker's raw `status`/`merged_at` rather than a computed "satisfied" flag, so `dropped` and
  landed-then-`reopen` stay distinguishable (`docs/proposals/master-orchestration.html`).

- Retrieval v3, phase 0 (ISS-904). Every hybrid memory search now records on its
  `retrieval_analytics` row how many hits the semantic list and the keyword list each produced and
  how many they shared, and `GET /api/admin/retrieval/breakdown?projectId&since` aggregates that per
  strategy for an admin. Four per-project retrieval settings land on `app_config` with today's
  behaviour as their defaults — `retrievalRerank` off, `memoryModel` `flat`, `retrievalExpandRelations`
  off, `memoryReindex` empty — settable by a project admin through `PUT /api/app-config/:projectId`
  (the reindex state is not). Nothing reads them yet; they are the switches the later phases of
  `docs/proposals/retrieval-v3-rerank-chunks.md` flip per project.

- **A box can now be configured to run more than one job at a time.** `devices.max_concurrent`
  (default 1, CHECK 1..16) is enforced end to end: the picker CTE, `selectRunnerForJob` and the
  locked claim all read the same cap, and all three count occupancy with `countInFlightForDevice`.

  The unit is the DEVICE throughout, and that is the substance of the change rather than a detail
  of it. A job consumes one Claude process on one machine, so a box bound to 20 projects at cap 3
  runs 3 jobs in total, not 3 per project. Pairing a device cap with the old per-binding count
  would have authorised twenty times the intended concurrency while every gate still read as if it
  were holding.

  Nothing changes for anyone who does not raise the column, and a box whose runner predates
  `0.10.5` is held at 1 no matter what the column says — that release is the first with the
  repo-root lock (`daemon/repo_lock.rs`), without which two jobs `merge --ff-only` the same index.
  The floor is resolved per runner at dispatch, in SQL and in TypeScript from one constant, because
  core deploys in one step while the fleet updates on its own clock.

  `claimRunnerSlot` no longer takes a `deviceId` argument: it stamps the device row it just locked.
  The parameter was a second opinion about the unit being enforced, and a caller passing `null` —
  harmless while the column was a legacy mirror — let two concurrent claims both succeed on one
  box. Deleting it turned that into a compile error, and typecheck then named every call site.

  `RUNNER_CAP_PER_RUNNER` is gone. The PM's runner-load report now shows each box's real effective
  capacity, so two bindings of one machine correctly report the same number.

- **The runner serialises writes to a repo root, so a box can hold more than one job.**
  `daemon/repo_lock.rs` keys one async mutex per repo path. A job takes it before preflight and
  holds it through `workspace::refresh` (`fetch` · `checkout --` · `merge --ff-only`, which run
  against the ROOT on every job, worktree lane included) and through `worktree add`; a lane that
  got its own worktree drops it once `runner.start` returns, and a root-owning stage (`pm`,
  `interactive`) keeps it for the whole session.

  Nothing observable changes yet — core still pins one job per runner, and that pin is what has
  been standing in for this lock. This is the piece that has to exist first: raising the cap
  without it lets two jobs `merge --ff-only` one index and rewrite files an agent is mid-read on.

  The wait sits deliberately BEFORE `lifecycle::ack`. Unacked, a job queued behind a busy root is
  still core's to place elsewhere; after the ack the same wait would be a silent stall that the
  three-minute session reaper answers by killing the job.

- Issue and comment bodies can be written as allowlisted HTML: `forge-*` components with typed
  attributes and slots, plus the plain tag set the markdown renderer already produced. Send
  `format: 'html'` on a comment create/update or an issue description; a valid body stores its root
  component name in `template` and reads back its parsed `slots`, so a downstream reader takes a
  field instead of matching `**Triage**` on a string prefix. An invalid `forge-*` element,
  attribute or missing slot is refused with 400 `BODY_INVALID` naming it — the mechanism that gave
  `releaseNotes` full compliance, where the guide asking for the same shape reached 14-28%.

  **Nothing existing changes.** `format` defaults to `markdown`, every pre-existing row was
  backfilled to it by the column default, and no shipped skill template was touched — so every
  reader still parses what it parsed yesterday. Plain prose is always valid: tag-free text is
  wrapped in `<p>` by blank line, and an unknown tag or a `<script>` is stripped and reported in
  `warnings[]` rather than refused, because a human should never be told no for typing a `<div>`.

  `forge_comments` gains an `update` action, without which a `<forge-artifact id>` could never be
  placed at all: the attachment needs a comment id, which does not exist until after the create.

  Reading paths see a compact text projection rather than markup — the agent prompt, the memory
  embedding, and both MCP serializers — so the 8,000-character description cap holds the same
  amount of requirements as before. Web rendering, the composer, the skill migration and a
  per-stage `bodyPolicy` are later phases: `docs/proposals/body-templates.md`.
- `LITELLM_FAST_MODEL` and `LITELLM_FAST_REASONING_EFFORT`: the system-job fast model (auto-titles,
  memory extraction and consolidation) can run a different model than the chat default on the same
  proxy, and its `reasoning_effort` is configurable (default `none`, for the reason recorded on
  `memory/llm.ts`). Measured 2026-09-04: `cx/gpt-5.6-luna` at `low` returned a title inside the
  24-token budget. The embeddings client joins the shared URL convention too — `EMBEDDINGS_BASE_URL`
  is the host, with or without a trailing `/v1`.

- An Anthropic Messages-wire chat adapter, `chat/providers/anthropic.ts`, registered as
  `anthropic` when `ANTHROPIC_API_KEY` is set (`ANTHROPIC_API_URL` defaults to `api.anthropic.com`
  and takes any Anthropic-format proxy; `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`). It sits behind
  the same OpenAI-shaped `ChatProvider` contract, translating on the way out (system → `system`,
  `tool_calls` → `tool_use`, `role:'tool'` → `tool_result` blocks in the next user turn, data-URI
  images → base64 `image` blocks, `response_format` → an uncached JSON instruction because the
  Messages API has none) and on the way in (`content_block_*` events → chunks and reassembled tool
  calls, `thinking` blocks dropped), so `runTurnEvents` and every toolset stay wire-agnostic. The
  system block and the last tool carry `cache_control: ephemeral`, and `promptTokens` is reported
  as input + cache read + cache creation so it means the same thing as the OpenAI adapter's.
  Selected per project through `app_config.chat_provider_id`, and the default whenever it is
  configured; a project can still pin `openai`.

  This reverses the 2026-09-03 "one adapter" line, and the reason is measured, not aesthetic:
  against one proxy serving the same Gemini and GPT models on both wires, the OpenAI wire never
  surfaced a cached-token count and silently ignored a `json_schema` response format on GPT
  (prose came back), while the Messages wire reported cache reads on every turn and returned valid
  JSON on both models. The retry and SSE-framing plumbing both adapters share moved to
  `chat/providers/sse.ts`; the OpenAI adapter is now a pass-through plus that module.

- The provider-chat loop measures what it sends. `CHAT_CONTEXT_BUDGET_TOKENS` (default 80,000
  estimated tokens; declared in `docker-compose.prod.yml` and both `.env.example`s) bounds every
  request `runTurnEvents` makes: history was windowed by count on the Rocket.Chat path and not at
  all on `POST /api/chat`, and eight tool rounds at 24k chars each could push a request past the
  model's window and surface as a bare `error`. `chat/context-budget.ts` pins the system message
  and the newest user turn, drops the oldest history first (an assistant `tool_calls` message and
  its `tool` replies move as one unit — a reply without its parent is a provider 400), then
  truncates the oldest intra-turn tool results in place, and tells the model on the first kept user
  message how many earlier messages it can no longer see. What was elided is written into
  `chat_logs.usage.elided` only when non-zero; a request whose pinned messages alone do not fit is
  logged as `overBudget` rather than silently sent short.

- `chat_logs.usage.cachedPromptTokens` — the OpenAI-compatible adapter reads
  `usage.prompt_tokens_details.cached_tokens` and the loop sums it across rounds, so the
  prompt-cache hit rate of a turn is now readable from the audit row instead of inferred.

- Chat tool calls are recorded as `{ name, arguments, round, isError, durationMs, resultPreview }`.
  `ChatToolset.execute` returns MCP's own `CallToolResult` — the chat tool layer is a wrapper over
  the MCP catalog, so an external server's `isError` now reaches the record instead of being
  flattened away by a string serializer that ran before the loop could see it.

- `app_config.chat_model_by_kind` (migration 0202) and `chatModelByKind` on
  `PUT /api/app-config/:projectId`: a per-turn-kind model on the same provider. Two kinds exist —
  `agentic` (tools offered) and `relay` (tool-less prose; the Rocket.Chat escalation synthesis
  passes `relay`). A kind with no entry falls to `chat_model`, then the provider default; a
  malformed map falls the same way rather than 503-ing every turn on the project. The map is
  replaced whole on PUT.

- `response_format` plumbing on the chat provider contract (`ChatStreamRequest.responseFormat`,
  `TurnCoreArgs.responseFormat`, `ExternalChatTurnArgs.responseFormat`). **No caller sets it** — the
  fenced-JSON parsing in `escalation-bridge.ts` reads a runner-hosted Claude Code session's output,
  not a provider call, so the one candidate had no request body to put it on. Added on the owner's
  decision of 2026-09-04 so the next structured-output caller has a wire to plug into. It reaches
  the provider only on a round that offers no tools (Gemini rejects function calling combined with
  a JSON schema), and an endpoint that 400s the parameter gets one retry without it.

- Runner pool labels can be set by a project admin: `labels` on
  `PATCH /api/projects/:id/runners/:runnerId`, and an inline editor on each runner card under
  Project → Runners. The column already gated releases (`releaseRunnerLabel` on the production
  binding matches it), but its only writer was `PATCH /api/runners/:id`, which the PAT fence does
  not reach and no screen called — sidpeak sat at `RELEASE_POOL_EMPTY` with three online runners
  and no way to name one.

- The phase journal over REST: `POST /api/pipeline-runs/:id/phases`, `POST .../phases/end` and
  `GET .../resume-point`. `forge_phase` was recorded as one of the tools that "cannot move" to the
  CLI, on the rationale that it is a session lifecycle hook rather than a data query. It is not: a
  phase keys on `(run, phase, attempt)` and its `issueId` / `jobId` / `agentSessionId` are optional
  provenance the driver never sends. That single tool was the reason an autonomous driver still
  needed MCP, because the bundled `forge-drive` skill declares a phase at every one of its seven
  boundaries.

  The REST twin is deliberately narrower than the tool it mirrors. It takes the run and resolves
  the project from it, so the cross-project write that `assertRunInProject` exists to catch cannot
  be expressed. And its end body is strict with `note` as the only artifact it will store: a
  free-form artifact is how a driver writes its own review verdict onto a phase no reviewer judged,
  and the database CHECK constrains `source`, not `kind`. The MCP tool stays until a runner ships a
  skill that calls the CLI form — two live paths for one transition, ending at the next runner cut.

  `docs/architecture/data-plane-surface.md` carried the same wrong claim about
  `forge_step_handoff`, whose three actions have been on `/api/issue-step-contexts` all along.

  The bundled `forge-drive` and `forge-review` skills call the CLI form and no longer name an MCP
  tool at all — with the phase journal reachable, nothing in the autonomous lane still needs one.
  The gate that caught the 2026-08-24 defect (76 finished `drive` jobs, one journal row, because
  the declare-a-phase line named a tool that writes no journal) moved with them: it now requires
  the three endpoints by name and refuses a body that still mentions `forge_phase`, because an
  instruction offering both leaves the agent free to pick the one its shell cannot reach. Reaching
  the fleet needs a runner release; until one is cut, running drivers keep the MCP path.

- `activity_log.actor_agency` — the audit row now records whether an agent or a person was at the
  keyboard, which `actor_type` cannot answer: a job token is held by an agent and owned by a
  person, so it writes `actor_type = 'user'` truthfully while an agent is driving. `Actor` requires
  `agency`, so the compiler names every writer rather than letting one omit it and record the
  column's plausible-looking default. `requireAnyAuth` carries agency the way `requireAuth` does —
  it had been handed a principal that knew the answer and kept only `userId`, so every attachment
  upload and comment posted through it filed a job token's work under its owner acting by hand.

  Per the owner's decision of 2026-09-02, existing rows are stamped `human` by the DEFAULT with no
  inference from `actor_type`, and no read path uses the column yet: `isAgent` still derives from
  `actor_type`, because a feed wired to this column today would lose the agent marker on every
  runner write in history. `kernel_transitions` does not have the column, and three writers hand it
  a placeholder they cannot justify — all four named, with what each needs, in
  `docs/proposals/agency-is-not-persisted.md`.

  `activity_log` moved to `db/schema-activity.ts` on the way, following
  `schema-journal.ts`: `schema.ts` sits 6.7x over the file budget and is frozen at that size, so
  the column could not land there without an amnesty. It is re-exported, so the table's ten
  importers are unchanged, and `drizzle-kit` reports no schema drift across the move.

- The Coolify deploy commands over REST: `GET /api/projects/:id/integrations/coolify`,
  `.../coolify/status` and `POST .../coolify/deploy`. `/api/projects` is on the PAT allowlist, so
  `forge-runner api` reaches them with a job token; before this an agent on the CLI could not
  deploy at all. The branch rules moved to `integrations/coolify/commands.ts` first and both
  surfaces call them, because `deploy` is what decides whether a PROD binding may dispatch — a
  bare `pipelineRunId` earns it only once proven to be this project's open release-batch run, an
  `issueId` only by having reached the release stage, and the run-less path never asks for it.
  That decision must not exist twice. `forge_coolify_deploy` drops from 444 lines to 282 and its
  four actions now dispatch to the shared commands. `confirm-prod-deploy` moved to the Coolify
  route module with them; it had been living in the provider-agnostic integrations file.

- `PATCH /api/issues/:id` accepts `sessionContext` and `detectorKey`. They were MCP-only, which
  left an agent on the CLI unable to record `sessionContext.branch` — the direct-ship marker
  `pipeline/work-evidence.ts` reads as proof that work exists, and therefore the evidence the
  merge gate now demands. The ISS-820 verified-claim walk moved to `issues/session-context.ts`
  and both surfaces validate through it, so a `verified*` key with no evidence is refused on
  REST exactly as on MCP. `MCP_ONLY_ISSUE_PATCH_FIELDS` is gone rather than left empty. This does
  widen what a browser session may write; that is deliberate, and the same walk applies to it.

- `POST /api/issues/:id/merge` and `DELETE /api/issues/:id/merge` — the merge claim over REST, so
  the CLI can make it without `forge_issues.mark_merged`. `merged_at` is what the feature-branch
  barrier reads to release every `blocks` dependent, so this is a claim that work shipped rather
  than a field edit, and it carries the same ISS-786 evidence gate the MCP action does. The whole
  write moved into `issues/merge-marker.ts` first: it lived inside the MCP tool, so a REST route
  could only have been a second copy, and a second copy is where the evidence check gets left out.
  `mark_merged` and `unmark` in `forge_issues` now call that one implementation and keep their
  responses unchanged.

- `GET /api/projects/:id/agent-sessions` and `.../agent-sessions/:sessionId` — the project-scoped
  half of the session reads. The existing `/api/agent-sessions` cannot serve a project-scoped
  token, because its list fans out across every project the caller can see; these name their
  project in the path, so the fence has something to check. The session read authorises on the
  row's project, not the path's, and answers 404 rather than 403 on a mismatch so it does not
  confirm the session exists.

- Per-project retry rescues and session failures: `GET /api/projects/:id/metrics/retry-rescues`
  and `.../session-failures`. Both existed only as a cross-project view that deliberately refuses
  access tokens, so neither was reachable by an agent.
- Three PM reads that were only ever reachable through a tool now have routes:
  `GET /api/projects/:id/pm/{snapshot,graph,runner-load}` — the state of a project's work, its
  dependency graph, and what each runner is carrying.
- A UX finding can now be recorded over REST: `POST /api/projects/:id/ux-findings`. Reading them
  was already a route; writing one was only possible through a tool, which is why the highest-
  traffic tool of its group could not be retired.
- Per-step pipeline durations for one project: `GET /api/projects/:id/metrics/step-durations`.
  The cross-project view already existed but deliberately refuses access tokens, since it reads
  across every project you can see — so this is the half a token can reach.
- A project skill can be pinned over REST — `PUT /api/projects/:projectId/skills/:skillId/pin`
  marks it an intentional, permanent divergence from its template, with the reason recorded
  against whoever declared it. Pinning had no route before, only a tool.
- The people you share projects with are now readable over REST, at
  `GET /api/me/collaborators` — who they are and what role they hold on each
  project you can see. Per-project membership was already a route; the
  cross-project view was the half that had none.
- A job now carries its own credential. When core dispatches a job it mints an access token scoped
  to that job's project, hands it to the runner on the dispatch frame, and the agent gets it as
  `$FORGE_PAT` — so `forge-runner api` works on a box nobody provisioned by hand. The token is
  minted as the person who queued the job, so it can do what they could and nothing more, and it is
  revoked the moment the job ends, by any route it can end: a normal finish, a cancel, a run
  closing around it, or a sweeper reaping it. Nothing to install and nothing to rotate: a token
  that outlives its job does not exist. Boxes with a hand-provisioned token keep working unchanged,
  and a runner too old to read the field simply uses whatever it already had.

- The whole Forge REST API is now callable from a shell: `forge-runner api <path>`, shaped after
  `gh api`. `issues`, `/issues` and `/api/issues` all mean the same endpoint; `-X` picks a method,
  `-d` sends a JSON body (`-` reads stdin, and a body that is not JSON is refused before anything
  is sent rather than after a round trip), `-H` adds a header, `-i` shows the response headers.
  It speaks with a personal access token — `forge-runner login --pat <token>` stores one, or
  `$FORGE_PAT` supplies it per-shell, and `doctor` says whether one is present. A token bound to a
  project reaches that project and answers 404 on every other, which is the same answer a project
  that does not exist gives, so a token cannot be used to find out which project ids are real. The
  handful of routes that resolve no project at all — access tokens, organisations, admin, and the
  personal inbox — refuse it outright rather than quietly serving the whole account, and a token
  minted read-only is refused on anything that writes. Failures are told twice, once for a person
  and once for a program: the HTTP outcome
  becomes an exit code that `--help` prints in full, and the same reason leaves on stderr as JSON
  carrying `retryable` — true only where trying the identical request again could actually
  succeed, which is a 429, a 5xx, or a connection that never landed. A conflict or a rejected
  request is never marked retryable, so a script that loops on it stops instead of spinning. The
  response body of a failed call goes to stderr and never to stdout, so redirecting output to a
  file leaves that file empty on failure rather than filling it with an error object shaped like
  an answer.

- The Rocket.Chat bot can now see the pictures posted to it. Screenshots are how a room reports a
  bug, and until now every one of them was invisible: the bot read the filename, answered from the
  words around it, and gave no sign that it had not looked. An image attached to a message the bot
  is mentioned in is fetched with the bot's own credential and shown to the model, and it stays
  visible across the next couple of questions, so a conversation about one screenshot works and not
  only the first question about it. Pictures are held by reference rather than copied into the
  conversation history, and a single request carries at most ~6 MB of them; an image too large, or
  one the bot cannot fetch, is left out and the question is still answered rather than failing.

- An issue the Rocket.Chat bot files from a message carrying a screenshot now arrives with that
  screenshot attached. Whoever picks the issue up sees what the reporter saw, instead of a
  description of it. The image is attached by the server on the way through, so the bot cannot file
  the report and forget the picture, and cannot invent an attachment that was never posted.

- Each issue's pipeline work now runs in its own git checkout instead of sharing the project's one
  working copy. Before this, every stage of every issue ran in the same directory, so two jobs on a
  machine could only ever be kept apart by refusing to run a second one — which is what the
  one-job-per-runner limit has really been doing. Stages of the same issue land in the same
  checkout, so what the coding stage wrote is what the testing stage sees. The stage that merges
  still runs in the shared copy, because merging needs the branch being merged into.

- A job that is going the wrong way can now be told so while it runs, instead of being cancelled or
  waited out. Until now there were two moments to give an agent direction — before it started and
  after it finished — and none at all across the one to three hours in between, so a run seen going
  astray in its second hour cost that hour and a whole re-run. The instruction is posted as a
  comment on the issue and becomes the running agent's next turn. Available from the API
  (`POST /api/issues/:id/steer`) and to other agents (`forge_steer`), so an agent watching a run
  can redirect it without a person in the loop. An agent that has stopped to ask a question is
  answered by commenting, as before; steering is for one that is still working, and it says so
  rather than doing something surprising. Every steer is recorded as an intervention, because a
  person reaching into a running agent is exactly what that count is for.

- Six things that were only reachable by an agent holding an MCP connection are now ordinary HTTP
  endpoints, so a shell, a script or a browser can do them too: the server's version and uptime
  (`GET /version`), an ops snapshot for one project or for every project you can see, a project's
  Divergence Charter (read and replace), a project's Postman write-target, and the three moves a
  batch release needs — read the batch, finish it, abort it. The MCP tools that used to be the only
  way in are gone in the same change rather than left beside the new routes, because two live paths
  to one rule is how the two stop agreeing. The release-batch endpoints name the project and the run
  separately, so they check the run belongs to the project before doing anything — a token fenced to
  one project cannot finish another's release, and it gets the same "not found" a missing batch
  gives rather than being told the run exists somewhere else.

- Work queued behind a paused pipeline run is now reported instead of sitting silently. Of every
  gate that can hold a `queued` job, `pipeline_run_not_running` was the only one with neither a
  reaper nor an alarm behind it: the picker only offers jobs whose run is `running`, so nothing
  behind a pause can start, and because the active-job index covers `queued`, nothing can queue a
  replacement step for that issue either — the issue is dead, not slow. Measured on the fleet
  2026-08-30, four triage jobs had been in that state for 38 days with no surface anywhere able to
  say so. A new sweeper pass notifies the project owner once per paused run past the threshold,
  naming what paused it, how many steps are frozen behind it, and — read from the pause kind, not
  guessed — whether it will resume by itself. The notification clears as soon as the run leaves
  `paused`, whether it resumed or was closed. Nothing is cancelled, re-queued or re-dispatched: a
  pause is either a machine condition that clears itself or a decision only a person can revisit,
  and a job killed here is work the resume existed to rescue. (ISS-879)

- A plan now records the branches that were weighed and dropped, not only the one that was taken.
  Forge keeps the issue rather than the conversation, so a rejected branch that is not in the plan is
  gone — and a plan without it reads exactly like one where nothing else was ever considered. Both
  plan-writing skills (the autonomous driver and the staged planner) ask for a `Rejected
  alternatives` section naming each branch and the fact that killed it, say that a forced choice is
  written as forced, and say that an empty heading is worse than none. What is checked is that the
  shipped bodies still ask; whether a given plan's rejected branches are real is prose no test can
  read. (ISS-883)

- `docs/VISION.md` and every proposal now say what adopting them costs the reader, and a gate keeps
  it that way. The constitution had a Boundaries section — what Forge will not become — and nothing
  pricing what choosing Forge takes from a team that chooses it, while the repo's own rule reads "a
  trade-off is priced or it is not taken". `check-honest-costs` refuses an absent section, one that
  prices nothing, and a `TBD` where the price goes; it cannot judge whether a stated price is honest,
  and says so. (ISS-882)

- Attention lists agent-filed `draft` issues that no human has looked at yet. `draft` is inert by
  design — the dispatcher never picks it up and nothing notifies on a draft create — so a proposal
  an agent filed used to be reachable from no surface in the product: measured 2026-08-30, 428 of
  them across 16 projects, all addressed to the account that paired the runner rather than to anyone
  who signs in. They now reach the project's admins, ordered by priority, capped at 20 rows with the
  real total shown; one human comment clears a row for good. (ISS-881)

### Removed

- **The skill rebase lane.** `sweepTemplateBumps` walked every project skill on each builtin seed,
  compared `basedOnGlobalVersion` against the template's current `version`, and wrote nothing — its
  only output was a log line and a `behindTemplate: true` flag on the effective-skill projection and
  the MCP catalog. Nothing consumed the flag: web-v2 and `@forge/contracts` reference it zero times,
  and the one writer that could clear it, `markRebased`, was reachable only from a hand-written MCP
  update. With the staged lane gone (ISS-895) there is no stage→skill dispatch left for a stale copy
  to affect — `skill_registrations` is empty fleet-wide — so the drift it measured had no
  consequence to report. `basedOnGlobalVersion` and `templateVersion` survive as adoption
  provenance, now carrying guards saying nothing recomputes them and that a gap is history, not a
  signal; `forge_skills.adopt` remains the one way to take a newer template, by hand, when someone
  asks for it.

  *Superseded the same day: the eleven `cm:ignore CM013` lines described below were removed once
  the counter was fixed (see Fixed → "A debt that could not fall by one"). The paragraph stands as
  the record of what was traded and for how long.*

  Six of those files carry a `cm:ignore CM013` this change added, and it is an amnesty with a
  price. The drain gate that landed hours earlier (ISS-844) asks for one frozen comment per edited
  file, and its counter cannot see one paid: `debtOf`'s `blockAlive` coarsening counts every frozen
  key while any frozen block survives, so a file's debt reads unchanged until it reaches zero.
  Measured on `effective.ts` 2026-09-05 — deleting 1 of its 19 left 19, deleting 4 left 19,
  deleting all 19 paid. Derivable prose was deleted in each of the six anyway; the cost is that
  those files are exempt from the drain until `plugins/forge-codemap/scripts/lib/drain.mjs` counts
  per key, which is where the ignores end.

- **The staged lane, and everything that only it read (ISS-895).** `PIPELINE_STEPS` — the nine-rung
  status × jobType × toggle × skill table — and the six maps derived from it are gone, with the
  eight staged skill bodies, the 178 `skills` rows that carried them, and their
  `skill_registrations` (migration `0209`). ISS-897 had already stripped the toggles that gated the
  lane, so the branch was unreachable before this; what it left behind was a table, a job-type
  scope, a stall guard and an alarm that each looked live and could not fire.

  Removed with it: `POST /api/projects/:id/skills/bootstrap` and its Balanced preset — it bound
  stage→skill registrations and nothing else, so the create-project wizard's second step now saves
  the repository settings and stops there; `forge_pm.dispatch`, which now refuses by name rather
  than enqueuing a job type no runner accepts; `forge_step_start`'s status flip, which read the step
  table (it says so in `statusNote` on every call, and `stage` is now required because nothing
  derives it); the `stale_trigger` dispatch-gate arm and its sweep, both scoped to job types that
  have a trigger status, which `drive` never had; `alarmChurningIssues`, which counted a
  `reopen_count` this lane never moves and so was frozen at 0; the stage-stall guard; the resume
  bound on reopen cycles, for the same frozen-column reason; and `steps` / `manualOnlyJobTypes` from
  the `GET /api/pipeline/registry` payload (version 6).

  The nine staged job types and the seven staged issue statuses stay in the enums: 29,874 historical
  `jobs` rows hold them and a read of one must stay representable. Absence from `RUNNER_CAPABILITIES`
  is what makes them unenqueueable now — a runner handed one fails it `runner_unsupported_type`,
  which is the loud refusal.

  What the migration touches, measured on forge-beta 2026-09-05: 16 issues stranded on a staged
  status across 7 projects are re-parked to `needs_info` with their prior status recorded in
  `metadata.iss895.priorStatus` (`released`, whose 79 rows are the release-batch park, is left
  alone); the 4 queued `triage` jobs left under paused runs are cancelled, because no runner may
  claim that type any more and `jobs_active_unique` would let one dead row block its own
  replacement forever. The price of emptying `MACHINE_RESUMED_PAUSE_KINDS` is named rather than
  discovered: 5 runs paused on `missing_skill:*` — whose resume path was deleted here — are freed
  by `resumeOrphanedPauses` on the first sweep after deploy, which is exactly what that pass exists
  for, and the migration cancels their queued work first so they come back to a clean queue.

- **The last of the push path, and the last ceiling core could name.** `selectRunnerForJob` and its
  three private arms (pin / least-loaded / standby) are deleted. Its only two remaining callers —
  the release-batch preflight and the skill smoke-verify dispatch — never used the runner it
  returned; both asked "is anyone alive" and threw `NO_RUNNER_ONLINE` otherwise, so both now ask
  `onlineCapableDeviceIds`, which answers that question without predicting a routing decision core
  no longer makes.

  With the selector went the last reader of `devices.max_concurrent`: `effectiveDeviceCap`,
  `deviceCapSql`, the `device_load` CTE and the `runner_full` gate reason. Keeping that reason would
  have been the worse half of the trade — nothing in core has refused a claim on capacity since the
  master began claiming from the pool, and the real ceiling (`duplex_max_sessions`, RAM, the
  repo-root lock) lives on the runner where core cannot see it, so `runner_full` could only report a
  hold nothing enforced and send an operator to wait for a slot that was never occupied. It is gone
  from `GateSkipReason`, from `PipelineWaitingReason`, and from web-v2's hand-mirror of it; rows
  written before today still render neutrally through `LEGACY_NEUTRAL_REASONS`. `forge_pm.runner_load`
  drops its `capacity` field for the same reason and reports the raw `inFlight` count alone. The
  column itself stays, unread, with a guard on the schema saying so — dropping it is a migration, not
  a deletion.

  The runner's own retired-key warning said *"pipeline concurrency is decided by core, per device"*
  and now says it is decided by the runner, naming `duplex_max_sessions`. That sentence was shipped
  to every operator who upgraded past a config carrying `max_concurrent`.

  **Known shortfall, priced rather than fixed:** `GET /api/runners/active` returns a single `current`
  job per runner, and a box may now be running several at once — it shows the first and drops the
  rest. Correcting it is a response-shape change reaching web-v2's runner types and project page, so
  it is deliberately not folded into the kernel change that surfaced it. The guard on the route says
  so at the collapse.

- **Core no longer pushes work at a runner, and there is no concurrency cap left in it.** The
  central picker, the dispatch tick, the pg-boss dispatcher and the `job.assigned` frame are gone,
  along with the per-project `pipelineConfig.maxConcurrentIssues` (migration `0205` strips the key
  from every project so the fleet is not left half-carrying a number nothing honours) and its
  Settings → Pipeline → Concurrency control. A master agent on the box claims from the pool
  instead, and how many issues run at once is its judgement, weighed against `GET /me/load`.

  **The blocker gate went with them.** A `blocks` edge no longer holds a job back anywhere: the
  relation is reported with the blocker's raw `status` and `merged_at` and the master decides what
  it means, which is the only reading that can tell a `dropped` blocker from one that merged and
  then bounced to `reopen`. `waiting_on_dep` and `project_full` are removed from the waiting-reason
  vocabulary in core, contracts and the UI rather than left rendering a block that can no longer
  occur, and the three dependency-alarm passes that existed to surface that gate are deleted.

  What core still enforces at claim time is one holder per job and **one in-flight job per issue,
  whatever its type** — `jobs_active_unique` is on `(issue_id, type)` and so does not cover a
  `code` and a `review` job running against one issue at once. Budget exhaustion keeps its ISS-823
  shape (a terminal job plus a `held` retry) rather than becoming a refusal that would leave the
  job in the pool for the next master to re-refuse and re-comment.

  A runner carrying `limit_reason='auth'` is a visible consequence: nothing excludes it from being
  claimed onto any more, so `GET /me/load` now reports `runnerFaults` verbatim and
  `forge-runner pool load` warns on them.


- **`[runner] max_concurrent` and `device_max_concurrent` from the runner's `config.toml`.** Both
  were parsed, serialized and written into every config file the daemon has ever produced, and read
  by nothing — the only places they appeared outside the struct were their own defaults and a
  round-trip serialization test. An operator who set `max_concurrent = 4` and restarted got exactly
  one job and no indication why, which is the silent substitution `CLAUDE.md` now forbids.

  Pipeline concurrency is decided by core, and until a per-device cap ships there is no runner-side
  knob that does anything. Removing the fields is safe for the fleet because the config has no
  `deny_unknown_fields`: an existing file carrying both keys still loads, and `save()` drops them on
  the next write. A value the operator can only have typed by hand — anything other than the `1`
  and `0` the tool itself wrote — is reported at load with the file path, rather than ignored.

  It warns and never refuses: those keys sit in essentially every deployed config, so failing hard
  on them would be a fleet-wide outage on upgrade. A loud break is meant to stop a wrong action, not
  every action.

- **The `antigravity` runner type and the `host='remote'` lane.** Both carried zero rows on
  forge-beta against 64 code references, and everything that existed only to serve them is gone
  with them: the adapter, its HMAC-signed `POST /api/runners/:id/events` callback, the
  content-hash-addressed `GET /api/runners/skills-zip/:hash` capability URL and the zip builder
  behind it, the SSE event normaliser, and the `runnerCallbackRoutes` sub-app (with the mount-order
  guard that existed to keep it in front of the auth middleware).

  `runners.host` and `schedules.runner` are dropped rather than left holding one legal value.
  `schedules.runner` is the sharper of the two: its DB default was `'antigravity'`, a value the API
  surface rejected, so any row that ever took the default was born undispatchable.

  **`runners.device_id` is now `NOT NULL`, with `ON DELETE cascade`.** A runner is a binding
  between a real paired device and a project; the nullable column existed only for remote runners,
  and every selection, dispatch and limit query already joins through it. Creating a runner without
  a device is now refused at the API and MCP boundary instead of producing a row nothing can
  dispatch to. The migration deletes remote and device-less rows first — without that, `SET NOT
  NULL` aborts on the first such row and the container serves new code against the old schema.

  Two `resolve-step-runner` tests were deleted rather than kept green: they used `antigravity` as
  "a registered type that is not the default", and with one type left the override and the default
  are the same string, so the assertions could no longer fail. The `cm:guard` on
  `KNOWN_RUNNER_TYPES` records that the override arm is uncovered until a second type returns.

- **`comments.is_ai`, and with it every per-comment claim about who was typing.** Authorship now
  follows the credential and nothing else: a device token is recorded as that device, and any other
  token as the person it belongs to. The column asked each writer to declare itself, and the answer
  disagreed with the token on 3,172 of 23,414 rows (measured 2026-09-04) — every one an agent
  holding a person's PAT, writing `is_ai=true` on that person's own identity while the column was
  documented as the durable human test. The MCP tool's hardcoded `true`, the REST route's stamp from
  `agency`, and the ~10 kernel writers are gone; `attachAuthors` and the `unseenDrafts` receipt now
  test `author_device_id` alone, and `forge_comments` returns that field so the driver's
  `answered()` check in forge-plugin keeps a park unanswerable by the job that opened it.

  **The price, stated rather than found later:** an agent on a person's PAT is now indistinguishable
  from that person — it can clear the `unseenDrafts` receipt as them, and no surface marks its
  comments. Measured before the drop: 20 `draft` issues leave the attention bucket on deploy,
  drafts whose only non-device comment an agent wrote on a person's credential; after the DROP that
  set is not recoverable. That is the honest reading of what the column already measured; it does not become true
  by deleting it, it becomes visible. The gap closes when agents get an identity of their own, which
  is a credential, not a boolean a writer fills in about itself. Until then `never speak for a human`
  is a rule in the drive prompt with no mechanism behind it, and the prompt now says so. Migration
  `0199_drop_comments_is_ai`.

- **Epic decompose is gone from the kernel.** A `decomposes` edge no longer creates a shared
  integration branch, parks the parent at `waiting`, cascade-approves the children, holds the
  parent's jobs behind a `decompose_children_pending` gate, or cascade-closes the family. The kind
  survives as a grouping label with no lifecycle: it shows epic → child in the UI and the graph, and
  gates nothing. Ordering between two issues is a `blocks` edge, as it always was.

  Splitting a large issue is now the coding session's own job — one plan with ordered steps on one
  branch — and a piece that genuinely ships on its own becomes its own issue behind a `blocks` edge.
  `forge-plan` Step 5.5 says exactly that; the decompose protocol and execution references are
  deleted, along with the decompose-aware guards in `forge-code`, `forge-test` and `forge-release`.

  What this costs the rows that exist: eight parents are parked at `waiting`/`on_hold` under a
  `decomposes` edge across five projects, and fifteen of their children sit at `draft`/`on_hold`.
  Approving such a parent no longer promotes its children — a person moves them, once. The
  `waiting_on_decomp_children` health reason is removed from the contract and the UI, and
  `metadata.useIntegrationBranch` from the schema; the per-issue `metadata.branchConfig` base-branch
  override stays and still wins over the project default.

- The PAT auto-revoke. A token that exceeded its per-minute ceiling in three windows of one hour
  was revoked for good, silently: no audit row, no event, no reason. It could only ever fire on a
  token `verifyPat` had already accepted, so it never touched a guesser, and the one thing it did
  was burn four of one user's tokens in a day for running a plugin session at 4 requests a second.
  A 429 is a throttle; it stays one. `forceRevokePat` is gone with it.

- **The bundled autonomous skill set and the runner-written review verdict.** Owner decision,
  big-bang. Five skills compiled into the runner via `include_str!` (`forge-drive`, `-understand`,
  `-plan`, `-review`, `-ship`, 560 lines), `bundled_skills.rs`, the `[skills] bundled_disabled` /
  `bundled_overrides` knobs, and the gate `check-autonomous-transitions.mjs` that held the skills to
  `AUTONOMOUS_DRIVER_STATUSES` — gone. The driver is now `issue-flow` from the `forge` Claude Code
  plugin (github.com/SidCorp-co/forge-plugin), named by `AUTONOMOUS_SKILL_NAME` and reaching a box
  through `pipelineConfig.plugins`. Why: a skill fix waited on a runner release the fleet then had to
  pull — 0.9.9 and 0.9.10 were cut on 2026-09-02 and 8 of 10 runners were still on 0.9.8 hours later
  — and `issue-flow` carries 724 lines of method to forge-drive's 242.

  With it, the reviewer-verdict mechanism: `FORGE_VERDICT_FILE`, `workspace/verdict.rs`, the poller
  in `claude_code.rs`, `POST /api/jobs/:id/verdict`, `recordVerdict`, and migration 0194 drops
  `phase_journal_verdict_is_runner_written`. **The price, stated rather than found later:** nothing
  now stops a driver recording its own approval. The measurement this mechanism answered — getcontent
  2026-08-21, 9 of 10 closed issues had a real verdict overwritten by the driver's prose — is reachable
  again. `endPhase` keeps its `kind IS DISTINCT FROM 'verdict'` clause so the rows that exist stay
  honest; the e2e that asserted the CHECK now asserts its absence, on purpose, so a return is a
  decision and not an accident.

  The `autonomous-mode` skill-lock reason went too, and that one was already dead:
  `projectLockContext` never passed a `bundled` set, so the branch fired only in unit tests that
  hand-supplied one. `check-autonomous-transitions` is unwired from `verify`, CI, the conformance
  manifest and `scripts/README.md` — with the skill in another repo it had nothing to read, and a gate
  that exits 2 forever is worse than no gate. `mcp/skill-tool-names.test.ts` went with it for the same
  reason — it read the bundled tree to assert no skill named an unregistered MCP tool, and that check
  now belongs to the plugin repo, whose `doc-claims.test.mjs` holds the equivalent for its own CLI.

  **What this does not do:** install the plugin anywhere. 0 of 31 projects designate it and every
  runner ships `[plugins] enabled = false` (a per-box kill switch the server cannot flip), so until a
  project designates and an operator turns the box on, a `drive` job is told to use a skill it does
  not have. Runner `0.10.0` carries the removal.

- Four MCP tools whose work REST already does: `forge_steer`, `forge_ux_improver`,
  `forge_skills.pin` and `forge_metrics.step_durations`. Nothing that runs on a build box had
  called any of them, and every one has an endpoint that does the same job. The registered tool
  set is now 59.

- The `intent` filter on `GET /api/chat-logs`. It matched `chat_logs.query_intent`, a column both
  insert sites have written `null` since the provider-chat rewrite replaced the Strapi-era
  intent router; the strict query schema now 400s `?intent=`. The column stays — historical rows
  may hold data, and dropping it is a separate decision. The two inserts stop naming
  `ragContext: null` and `queryIntent: null` explicitly.

- **`registry.ts:unregister`, and two comments that outlived the second adapter.** The registry
  export had zero callers anywhere in the tree — it was the swap-out half of a multi-provider
  world, and there is one provider now. `auto-title.ts:generateSessionTitle` still told readers the
  fast model was "LiteLLM OpenAI-compat or Gemini", and `lib/feature-flags.ts`'s `chatProvider`
  note still described "LiteLLM + Gemini SSE" and env vars "(or Gemini equivalents)" that
  `config/env.ts` no longer declares. Nothing here changes behaviour; all three were made wrong by
  the deletions above, and a comment naming a deleted env var is how the next reader configures a
  variable that does nothing.

- **The Gemini chat adapter.** It accepted a `ChatStreamRequest` and ignored four fields of it:
  `tools` and `toolChoice` (so `requireInitialToolUse` was a no-op and the Rocket.Chat bot would
  have run tool-less, failed `screenStakeholderReply`, retried tool-less, and fallen back), plus
  `temperature`, and `signal` — which it only polled between chunks, never handing it to the SDK, so
  the hung-upstream abort `external-chat.ts` documents did not exist on that path. Its tests covered only multimodal mapping. A
  second provider path that cannot serve the product's only agentic caller is two live paths and a
  reader who cannot tell which one runs. `@google/genai` goes with it, and so — owner decision, once chat
  had a single adapter — do `GEMINI_API_KEY` and `GEMINI_MODEL` themselves, along with the direct
  `generativelanguage.googleapis.com` fallback in `memory/llm.ts` that was their last reader. A
  proxy that already fans out to Vertex makes a second vendor client a second thing to keep true.
  **This is a breaking configuration change**, and two earlier drafts of this entry got its reach
  wrong in opposite directions, so precisely: `bootstrapChatProviders` registered `gemini` whenever
  `GEMINI_API_KEY` was set, and `config/env.ts` declared it — but `docker-compose.prod.yml` never
  passed it through, so on a compose deployment it never reached the container and the id was never
  selectable there. On a directly-run core (dev, or any non-compose host) it was. Either way, a
  deployment that relied on Gemini — for chat OR for the fast model — now has neither: chat logs
  `chat provider: none configured` and 503s, and `fastModelConfigured()` reports false, so
  memory-v2 extraction, consolidation and auto-titling skip rather than failing quietly. `LITELLM_*`
  is the only path to both. Projects already pinned to `gemini` still resolve, because the id stays
  registered as an alias of the OpenAI adapter: the row outlives the code that wrote it, and
  `resolveForProject` would otherwise drop the row's `chat_model` and silently re-pin it to the env
  default.

- **The bundled autonomous skill set and the runner-written review verdict.** Owner decision,
  big-bang. Five skills compiled into the runner via `include_str!` (`forge-drive`, `-understand`,
  `-plan`, `-review`, `-ship`, 560 lines), `bundled_skills.rs`, the `[skills] bundled_disabled` /
  `bundled_overrides` knobs, and the gate `check-autonomous-transitions.mjs` that held the skills to
  `AUTONOMOUS_DRIVER_STATUSES` — gone. The driver is now `issue-flow` from the `forge` Claude Code
  plugin (github.com/SidCorp-co/forge-plugin), named by `AUTONOMOUS_SKILL_NAME` and reaching a box
  through `pipelineConfig.plugins`. Why: a skill fix waited on a runner release the fleet then had to
  pull — 0.9.9 and 0.9.10 were cut on 2026-09-02 and 8 of 10 runners were still on 0.9.8 hours later
  — and `issue-flow` carries 724 lines of method to forge-drive's 242.

  With it, the reviewer-verdict mechanism: `FORGE_VERDICT_FILE`, `workspace/verdict.rs`, the poller
  in `claude_code.rs`, `POST /api/jobs/:id/verdict`, `recordVerdict`, and migration 0194 drops
  `phase_journal_verdict_is_runner_written`. **The price, stated rather than found later:** nothing
  now stops a driver recording its own approval. The measurement this mechanism answered — getcontent
  2026-08-21, 9 of 10 closed issues had a real verdict overwritten by the driver's prose — is reachable
  again. `endPhase` keeps its `kind IS DISTINCT FROM 'verdict'` clause so the rows that exist stay
  honest; the e2e that asserted the CHECK now asserts its absence, on purpose, so a return is a
  decision and not an accident.

  The `autonomous-mode` skill-lock reason went too, and that one was already dead:
  `projectLockContext` never passed a `bundled` set, so the branch fired only in unit tests that
  hand-supplied one. `check-autonomous-transitions` is unwired from `verify`, CI, the conformance
  manifest and `scripts/README.md` — with the skill in another repo it had nothing to read, and a gate
  that exits 2 forever is worse than no gate. `mcp/skill-tool-names.test.ts` went with it for the same
  reason — it read the bundled tree to assert no skill named an unregistered MCP tool, and that check
  now belongs to the plugin repo, whose `doc-claims.test.mjs` holds the equivalent for its own CLI.

  **What this does not do:** install the plugin anywhere. 0 of 31 projects designate it and every
  runner ships `[plugins] enabled = false` (a per-box kill switch the server cannot flip), so until a
  project designates and an operator turns the box on, a `drive` job is told to use a skill it does
  not have. Runner `0.10.0` carries the removal.

- Four MCP tools whose work REST already does: `forge_steer`, `forge_ux_improver`,
  `forge_skills.pin` and `forge_metrics.step_durations`. Nothing that runs on a build box had
  called any of them, and every one has an endpoint that does the same job. The registered tool
  set is now 59.

### Fixed

- **The connections directory told seventeen credentials apart by nothing at all.** Every card on
  `/integrations` fell back to its provider label, printed that label a second time as a pill beside
  itself, and offered no other detail — because `GET /api/integration-connections` returned no
  binding, project or endpoint information for the cards to show. The list route now carries `usage`
  (the bindings, with project and environment) from one batched query rather than a fetch per card,
  and a card names the endpoint its credential points at, the projects using it, and the provider
  only when that is not already its title. `POST /api/integration-connections` also names a new
  connection from the config it was given (`coolify · deploy.example.com`), so rows stop arriving
  anonymous; the existing rename in the edit drawer is unchanged.

  Three states the screen had been reporting falsely are now distinct. "No connections yet" was
  rendered for an org scope that was merely *hiding* connections, which reads as data loss to whoever
  created them — a filtered-empty scope, an out-of-scope one and a genuinely empty workspace now say
  which of the three they are. Disable/Enable/Remove were offered to a principal the API answers
  `403`; a member who can see an org credential but not change it is told so instead. And "Projects
  using this connection" answered `404` to that same member, because `GET
  /api/integration-connections/:id/bindings` gated a READ on the manage check — reads now gate on
  visibility, which is the set the list route already showed them.

  Search and provider filters arrive with the card rebuild (matching on project name too, which is
  how an operator actually looks a credential up), and Remove is reachable from the card behind a
  confirmation that names how many projects it disconnects.
- **`archmap` was blind to 35 first-party import edges.** `.arch-tsconfig.json` taught
  dependency-cruiser web-v2's `@/*` alias but not `@forge/contracts`, whose package `exports`
  subpaths it does not follow — so every import of the shared contracts package was unresolvable and
  therefore silently *dropped* from the graph the relations gate checks. Same failure the file's own
  comment records for the `@/*` alias, one package over. Unresolvable edges fell from 204 to 166.
- **A release run no longer reports `completed` on the evidence that somebody asked for a deploy.**
  Measured on the fleet 2026-09-06: `integration_deliveries` held 5,408 outbound rows and **zero**
  inbound ones since 2026-05-27, `release.deploy.done` had been stamped **zero** times, and **50
  runs sat at `status='completed'` while their own `current_step` still read
  `release.deploy.in_flight`** — the run contradicting itself in one row. The one mechanism that
  would have checked, an inbound Coolify webhook, was unreachable by construction: Coolify's
  `SendWebhookJob` does `Http::withOptions(...)->post($url, $payload)` with no event header and no
  signature, and `POST /in/:slug` requires both.

  A deploy now writes a **confirmation hold per target** onto its run, and `closeRun` /
  `closeOpenRunForIssue` ask that hold before writing `completed`. Every target confirmed → the run
  closes as asked. A deploy Coolify reports failed, or one still unconfirmed 30 minutes after
  dispatch → the run closes **`failed`**, with `current_step` naming the target and the reason. A
  deploy genuinely still in flight → **the close is deferred**, not weakened: the run stays
  `running` at `release.deploy.in_flight (k/n)`, which is true, and the confirmation performs the
  close when the last target lands. The outcome is read by polling
  `GET /api/v1/deployments/{uuid}` — a client that already existed and had only ever been called
  when a human asked — and every terminal read writes an inbound-direction delivery row, so the
  audit log carries both directions again from a source that exists.

  The unreachable path was **removed, not repaired**: `coolifyAdapter.handleInbound` now refuses by
  name, `canReceiveWebhook` is `false`, the `x-coolify-event` and `x-coolify-signature-256` entries
  are gone from the inbound router, and the settings screen no longer tells an operator to paste a
  signing secret into a Coolify field that does not exist. Repairing it would have added a second
  writer of run-terminal state for a message Coolify cannot send. The GitHub inbound adapter, which
  does send `x-github-event` and does sign `x-hub-signature-256`, is untouched.

  Bounded by construction, and the bound is the trade: 30 minutes is below the 60 of
  `RESULT_QUIET_MINUTES`, so the gate always resolves before the sweeper's window opens and two
  mechanisms never decide one run's outcome. The price is that a build slower than 30 minutes fails
  its run; it ends when a project can declare its own deadline. A deploy asked for after its run
  already closed — 81 of 4,247 measured — is reported at ERROR level instead of being stamped onto
  a run that cannot witness it. (ISS-922)

- **The GitHub App manifest sent GitHub three URLs this core does not serve.** `buildAppManifest`
  built `redirect_url`, `setup_url` and `hook_attributes.url` from `APP_BASE_URL`, which is the WEB
  frontend — `env.ts` says so, and `auth/email.ts` already resolves the same split for verification
  links. On a subdomain-split deploy all three landed on the Next.js app and 404'd. The redirect
  fails visibly, and at the worst moment: GitHub has already created the App, the signed state is
  spent, and only a hand-edit recovers it. `hook_attributes` fails **silently** and forever — the
  integration renders as configured while every delivery misses. The manifest now takes the web and
  API origins separately; only the App's homepage is the web one.

  Rather than trust the env alone, the connect route now **refuses before anything is created** when
  the origin it would give GitHub is not the origin the request reached core on, naming both and
  saying which variable to set. The check reads the request only to refuse — the callback is where
  GitHub delivers the code that yields the App's private key, so a forged `Host` must never be able
  to choose that URL, and here the worst it can do is deny.

- **The last step of the GitHub install refused the case its own guard described.** `setup_url`
  carries no `state` when the operator installs the App from its settings page — which is where
  GitHub lands you after creating it. The guard on that route said so, and said refusing would
  strand the flow with the App already created; the line under it refused anyway. The binding is now
  identified from the installation itself, and ownership is **proved** by asking GitHub with each
  candidate App's own JWT, because an App JWT reads only its own installations. Picking the caller's
  single unconfigured binding would have worked until a second project connected, then written one
  project's installation id onto another's.

- **Two more shapes of run that showed as live work no box was doing.** ISS-923 closed `running`
  runs whose jobs had all finished; a `paused` run in the same state, and an issue run that never
  grew a job at all, were reached by nothing and kept inflating the live-run count. Both are now
  reaped to a terminal status after the same 60-minute quiet window. A paused run is admitted only
  when it also holds no live session — an operator's hold that could still be resumed into work is a
  decision no sweeper may undo, and this is the one shape where there is provably nothing left to
  resume into. (ISS-654)

- **A runner that went away weeks ago stops counting as fleet.** A box that was paired once and
  never came back sat `offline` forever: nothing walked it past that status, so it inflated the
  fleet count and kept stage device pools pointing at nothing. It is now flagged `disabled` after
  the configured number of days, with an audit row saying why. Never a runner still holding a
  dispatched or running job, and never a row delete — a returning box re-registers itself on its
  next heartbeat. (ISS-654)

- **Half the phase journal recorded numbers nobody can read back, because the drive prompt's
  example said `phase-1`.** `phase_journal.phase` is free vocabulary and no gate reads it — both
  deliberate — so the worked example in `buildDrivePrompt` is the whole specification. It carried
  the literal `phase-1` from 2026-09-02, agents copied it, and 542 rows landed named `phase-0`
  through `phase-8` across every autonomous project on the instance. `phase-4` cost 6.8 hours on
  forge-dev alone and nothing can say what it was; worse, two runs' `phase-4` need not have been
  the same step, so every aggregate over them summed unlike things.

  The example now reads `understand` — a name 161 existing rows already use for that step, so
  autonomous rows aggregate with staged ones instead of forming a second bucket — and three lines
  beside it say to name the phase for the step in words, never by its number, reusing the name an
  earlier run used. Nothing gates the column and nothing should: a gate on the name would turn a
  free vocabulary into a contract the agent can break by being descriptive. The unit test asserts
  the digit, not the wording.

  The 542 rows are **not** rewritten. What step each was is not recoverable, and guessing would put
  invented data in the one table that exists to be evidence. They are told apart by pattern rather
  than by date: `phase_step_durations` gains `step_named`, false exactly when the name matches
  `^phase-[0-9]+$`. A boundary date would have been wrong — the fix is a seed, not a gate, so a
  session on a stale plugin can still write an ordinal next week and a date-based reader would
  count it as readable.

  The other half is `guides/skills/issue-flow/guide.md` in `SidCorp-co/forge-plugin`, whose
  headings are `## Phase 4 — Implement` and which is read in the same context window. No gate in
  this repo can hold that pair; the `cm:guard` on `buildDrivePrompt` is the only record of it.

- **A `stateContext` entry could not be deleted through any external caller.**
  `mergeStateContext` has always implemented `null` as its per-jobType removal sentinel and said so
  in its own JSDoc, but `stateContextSchema` never marked the entry `.nullable()`, so the `null`
  was rejected at the door — by REST and by MCP `forge_config` alike, both of which validate through
  it. The only expressible deletion was wiping the whole map. Found by the Settings → Pipeline
  editor added in this release, which is the first caller to try it and got a 400 naming a shape the
  merge below it documents as supported. The `cm:guard` on the schema now records why the `.nullable()` has to stay.

  `StateContextPatch` went with it — a widening type whose comment read *"Zod doesn't model the
  null-to-remove sentinel on per-state entries, so we widen here."* Zod models it now, `StateContext`
  already carries `| null` per entry, and its only caller was the merge in the same file.

- **The Pool admission toggle now reaches the route that can write `runners.status`.** It sent
  `{status}` to `PATCH /api/projects/:id/runners/:runnerId`, whose body schema is `.strict()` over
  repoPath/branch/labels — so every attempt to withdraw or readmit a box came back `400
  Unrecognized key: "status"` and surfaced as a generic "Save failed" toast. The status writer is
  `PATCH /api/runners/:id`, which hands the transition to `setRunnerStatus` and audits it into
  `runner_events`; admission goes there now.

  Nothing caught it because nothing asserted the URL, and the two routes differ only by prefix.
  There is a test for that now, and it fails naming the route when the prefix moves. The
  consequence was not cosmetic: an operator who retired a runner had no way back through the UI,
  and `forge_runners` MCP has `retire` but no enable, so a box withdrawn from a project stayed
  withdrawn. Un-retiring one meanwhile goes through `POST /api/projects/:id/runners`, whose upsert
  recomputes status from device freshness.
- **A pipeline run now ends when its jobs do.** The repo stated and defended its orphan invariant in
  one direction — no child job may stay non-terminal under a terminal run — and nothing at all
  defended the inverse. The cascade fires when a run *closes*; nothing fired when the *last job* of
  an open run finished, so a run whose jobs had all reached `done` simply stayed `running` forever.

  Measured on the fleet 2026-09-06: **98 of 114** `running` runs across 18 projects had every child
  job terminal, oldest 2026-05-26 and newest 2026-09-04 — a live leak, not a historical backlog.
  Each one rendered as an in-flight pipeline no box was doing, and each recovery was a hand-driven
  cancel plus transition.

  `pipeline/runs-concluded.ts` is the missing detector, driven from the sweeper tick beside the two
  run-axis reapers that could not reach these rows (`reapOrphanedOneShotRuns` requires a job-less
  run; `reapOrphanedIssueRuns` requires a closed issue). It admits a `running` run only when it has
  jobs, none of them is `queued`/`dispatched`/`running`/`held`, and none has been touched within
  `RESULT_QUIET_MINUTES` — then closes it through the existing `closeRun` SSOT, so there is still
  exactly one writer of a run's terminal status. The outcome is the **last** job's, so a run whose
  last job failed cannot close `completed`, while a failure retried to success still can. Every
  reap logs its run and project before the write, and the standing backlog drains on ordinary ticks
  rather than through a migration.

  The invariant is now written both ways in `CLAUDE.md`, and the whole lifecycle — both directions,
  and what each symptom means when it goes wrong — is drawn in `docs/flows/lifecycle-pipeline.html`.


- **A job waiting for a duplex permit killed another project's jobs, and blamed the lock.**
  `dispatch.rs` took the repo-root lock, called `runner.start`, and released it only when that
  returned — but `start` awaited the box's duplex session semaphore with no deadline, so the root
  lock was held across an unbounded queue. Every sibling job for that repo then died at
  `REPO_LOCK_WAIT` (600s) saying `repo_lock_timeout`, went back to the pool, was claimed again and
  met the same wall. Measured on forge-vm 2026-09-05: 7 timeouts in 30 minutes, all on `codemap`,
  whose pool never drained across four master passes — while the permits were held by `forge-dev`
  jobs a resident master had claimed 24 seconds earlier, with nothing in any record connecting the
  two.

  The two waits no longer nest. `git worktree add` — the only root-touching work `start` ever did —
  moves into `dispatch::handle`, inside a lexical block that also binds the lock guard, so the
  compiler releases the root before the permit is asked for. The permit wait itself is now bounded
  by `SESSION_PERMIT_WAIT` (10 min, one residency window) and fails as
  `session_permit_saturated: all N duplex permits on this box held after 600s; holders: <projects>`
  — which core classifies `infra` + **failover** with the cause `box_session_saturated`.
  `PRE_SPAWN_BEAT_BUDGET` still derives from the waits rather than being picked, now from both of
  them.

  What that classification does NOT yet do is move the job. On the pool path `readPool` selects on
  `status`, `held_by` and `retry_after_at` and nothing about routing — its own guard forbids adding
  any — so `_autoRetry.target` is read only by the push dispatcher, and the saturated box may claim
  the clone again. Worse before it is better: `failover` sets `immediateFailover`, so the clone is
  claimable with **zero** cooldown where `repo_lock_timeout` used to pay `RETRY_COOLDOWN_MS`. That
  is a priced trade: what this change buys is a job row that says `box_session_saturated` instead
  of `repo_lock_timeout` + `unclassified`, which is B3's "distinguishable by whoever re-claims";
  B3's "cannot spin" needs a master that can see permit pressure, and `pool load` reports no permit
  figure at all. That is the master-orchestration work the issue puts out of scope, and it is
  written down in `docs/proposals/pool-cannot-route-around-a-full-box.md` rather than left as a
  sentence nobody owns.

  Two causes join the taxonomy with it: `box_session_saturated` for the above, and
  `repo_root_contention` for `repo_lock_timeout` — which is now a different event, meaning a
  sibling genuinely spent ten minutes in preflight or `git worktree add`, and which had been
  landing in the operator review queue as `unclassified` because no policy rule claimed it. Both
  are matched above the cc-startup signal, because a job that died in either wait never spawned
  and so carries that signal by construction — below it they would have been unreachable.

  **`preflight_failed` was already losing that race**, and this fixes it too. Every preflight
  verdict sat below the same signal, so ISS-808's deliberately terminal one — a project with no
  git repo cannot fix a missing work tree by retrying anywhere — was being converted to a
  cross-box failover, and the prefixes outside that terminal three, `push_credentials` among
  them, were landing as `agent_startup_failed` on jobs that never started. Preflight takes
  longer than one 25s heartbeat whenever the lock wait, a re-provision, the setup agent or a 20s
  `ls-remote` timeout is in play, which is most of the time. All four move up together.

  One trade-off, priced: `SESSION_PERMIT_WAIT` is the DEFAULT residency window, and
  `sessionResidencySeconds` is per-project and allowed up to an hour. A project that raises it
  gets jobs failing at 600s that a longer wait would have served — they fail over rather than die,
  and no project sets the key today. The first one that does moves the number.

  The runner half ships at `0.11.2`. `runner-v0.11.1` was cut hours before this fix, and
  `update::apply` gates on `is_newer(manifest.version, CURRENT_VERSION)` — so a re-cut `0.11.1`
  would have reached no box already on `0.11.1`, and the fix would have been merged, released and
  still absent from every runner it was written for.
- **A mirrored GitHub close no longer claims the work shipped, and a pull request no longer becomes
  an issue.** Both defects sat in `handleGitHubEvent`, which had no test of any kind until now —
  which is why they sat there.

  `issues.closed` stamped `merged_at` via COALESCE, mirroring the state-machine writer's rule for
  work Forge itself drove to done. But `merged_at` releases every `blocks` dependent as if the code
  had landed, and GitHub sends the same event for `wontfix`, `duplicate` and `not planned` — so a
  duplicate closed upstream would have dispatched its dependents against code that does not exist.
  A mirror of somebody else's tracker knows only that the row is closed, and now records only that.

  `pull_request.opened` filed a Forge issue per PR. A PR is a change under review, not a unit of
  work with a deliverable and an owner, so it fails every admission gate in the `what-is-an-issue`
  guide and arrives owned by nobody. What a PR event is for is advancing the issue its branch
  already belongs to; that mapping comes with the pull-request verbs, and until then the event
  falls through to the unhandled-event log, which is the honest answer rather than the nearest one.

  Both are covered by `tests/integration/github-webhook-mirror-e2e.test.ts` against real Postgres,
  because both assertions are about a column: restoring the stamp turns the close test red with
  `expected '2026-09-06 04:48:00.449163+00' to be null`.

- **Coolify deploys go out as POST, before the GET stops being a deploy.** `client.ts` triggered
  every deploy with `GET /api/v1/deploy?uuid=&force=`. Upstream `0633b543` (2026-07-19, released in
  v4.2.0) repointed that route at a stub returning **405 `This endpoint has changed to a POST
  request.`** — the path still resolves, so the failure would have arrived as a 405 on every deploy
  of every one of the 13 Coolify connections at once, on whichever day someone upgraded the
  instance. `manage.musetools.com` is still on ≤ v4.1.x: 5,392 outbound deliveries `ok`, the last on
  2026-09-05, so nothing is red today.

  The route was `Route::match(['get','post'], '/deploy')` before that commit, so POST is accepted by
  every version in the field and this is one method swap, not a fallback pair. `client.test.ts`
  asserted `init.method === 'GET'` — a green test pinning the shape that was scheduled to break; it
  now asserts POST, with a second case proving a 405 surfaces as a `CoolifyApiError` still carrying
  Coolify's own message. The same commit did this to `applications/{uuid}/start|restart|stop`,
  `servers/{uuid}/validate` and `enable`/`disable`; Forge calls none of those yet, and the `cm:guard`
  on `deploy` names them so the next one added starts on POST.

- **A withdrawn runner still took jobs.** `readPool` joined `runners` only to prove a binding
  existed and read nothing else from the row; `claimJobForMaster` checked the agent version and
  nothing about the box. So `runners.status` — which has carried `draining` and `disabled` since the
  table existed — gated no code on the claim path: `forge_runners drain`, `forge_runners retire` and
  the status PATCH all wrote a column nothing consulted. Proved by planting the fix's own tests
  against the old code: a `disabled` runner's claim returned `ok: true`.

  Admission is now one predicate in `devices/pool-admission.ts`, read twice on purpose. The pool
  excludes a withdrawn box, and the claim refuses it again by name — `runner_withdrawn`,
  `device_disabled`, `runner_unbound` — because a master holds its page of pool rows across the
  round trip, so an operator draining mid-flight is only caught on the second reading. A silent
  empty pool and a named refusal are the same transcript to an operator whose box went quiet, and
  only one of them can be acted on.

  It excludes `disabled`/`draining` rather than requiring `online`: the heartbeat mirror is what
  writes `online`, so requiring it would hand a live runner an empty pool whenever that mirror
  lagged. A master reading the pool is alive by definition — the poll is the proof — so admission is
  a permission question, not a liveness one.

  Third half, and without it the other two are theatre: the heartbeat mirror preserved `disabled`
  and overwrote `draining`, so a drain had a ~30-second life. That is the same defect fixed for
  `disabled` on 2026-08-14 (retired 08:19:29, online again 08:19:59) and left standing for its twin,
  invisible because nothing read either. The mirror now preserves both, and the guard names
  `pool-admission.ts` as the authority on which statuses withdraw a box.

  Project settings → Runners carries the switch: **Takes jobs from the pool**. Off drains — work
  already running finishes, nothing new is offered or claimed. A retired (`disabled`) runner shows
  the toggle locked with the reason, because that one is undone by re-registering, not by a click.

- **A stale coverage report answered for code that no longer existed.** `check-flow-coverage`
  treats the integration coverage report as the authoritative evidence that a `cm:flow` step is
  defended. It handled an ABSENT report (skip locally, fail under `--require-sources`) and had
  nothing at all for a stale one, so an old report read exactly like a current one. Measured
  2026-09-06: `pnpm verify` was green on *"6 settled end-to-end"* from a report dated 2026-08-31 —
  taken before the staged lane was deleted — with the unit report beside it dated 2026-08-13.
  Regenerating both changed the numbers it prints (`release/reap` went `e2e=7` to `e2e=5`), which is
  what the six days of silence had been worth.

  A source now declares in `.forge/conformance.json` the `scope` its report claims to measure, and a
  report older than that scope is unusable evidence. Where that is fatal differs on purpose: CI
  produces the report in the same job, so `--require-sources` fails on a stale one; locally stale is
  the normal state — every edit outdates it — so it degrades to the same skip an absent report takes
  and says which file outdated it. A local gate that demanded a three-minute coverage rebuild before
  every `verify` would be deleted rather than obeyed. The floor is the scope's last commit time
  maxed with working-tree mtimes: mtimes alone call every report stale after a `git checkout`,
  commit time alone misses the uncommitted edits a local run is made of.

- **A debt that could not fall by one was a wall, not a debt.** `CM013` asks an edited file to pay
  one of its frozen comments, and its counter could not see one paid. `debtOf` OR'd a single
  per-FILE `blockAlive` into every frozen key, so a file was charged its whole frozen count while
  *any* of its comment blocks survived. Measured on `packages/core/src/skills/builtin-seed.ts`
  2026-09-05: deleting 1 of its 19 frozen comments left the debt at 19, deleting 4 left 19, and only
  deleting all 19 paid. The gate asked for one comment and would take nothing less than the file,
  which is how eleven `cm:ignore CM013` lines went into two commits in a single afternoon — an
  escape hatch spent as routine is a gate switching itself off.

  Fixed upstream in `forge-pipeline-skills` (codemap 0.16.1, vendored here): ISS-21's reflow credit
  is kept but charged per **block** — a rewrapped block keeps its block key while every line key
  under it changes, so it stands in for the frozen prose it still holds and costs one, not the
  file's total. Both call sites still compute it from the analysis alone, which is what lets
  `cm verify`'s debt line and the rule keep agreeing without a base revision. All eleven ignores are
  gone; verified on `mcp/tools/forge-issues.ts` — a code edit alone reports *37 still frozen*, and
  deleting one frozen comment clears it.

  Priced (`cm:hack codemap ISS-9` on `debtOf`): a block whose frozen keys were *all* rewrapped is charged
  1 rather than the count it held, so rewrapping a two-comment block beside a code edit lowers the
  debt by one and passes. Closing that needs the baseline to record each block's key count, which is
  a re-freeze; until then the loophole is narrow, deliberate, and named in the code. The plugin's
  golden corpus could not see any of this — every drain case lived in a one-block file, where a paid
  comment always takes its block key with it — so two cases now use a two-block file, and the
  payment one fails on the old counter naming its own rule.

- **Revoking a device was impossible for an OAuth-only owner.** `DELETE /api/devices/:id` sat behind
  `requireFreshAuth(5)`, and the only thing that stamps `last_fresh_auth_at` is
  `POST /api/auth/reauth` — which refuses any account whose `passwordHash` is NULL. So for every
  owner signed in through GitHub the gate did not add a step, it removed the action: no sequence of
  clicks in the app could revoke a device, and the Runners screen answered the 403 with a banner
  pointing at a Settings tab that has no standalone re-auth control. Found by a GitHub-authed owner
  trying to delete six retired runner hosts.

  The gate is removed from that route — ownership was always the authorization — and the
  confirmation moves to where it belongs: the Revoke control now asks for the device's name typed
  back, exactly, before it will fire. The match is deliberately strict (no lowercasing, no prefix,
  no trimming beyond the ends) because two hosts in this fleet are called `ubuntu6` and
  `ubuntu6 (barlow)`. This trades a stolen-session guard for one against a misclick; the route's
  `cm:guard` records that trade and what re-adding a gate would first have to solve. The misleading
  banner is deleted rather than reworded. `requireFreshAuth` still gates PAT create/revoke, where an
  SSO re-auth path exists.

- **Revoking a device could not be done from the app at all.** `DELETE /api/devices/:id` sits behind
  `requireFreshAuth(5)`, so a revoke by anyone signed in more than five minutes ago answers 403
  `FRESH_AUTH_REQUIRED` — and the Runners screen reported that as a plain failure, then pointed the
  operator at a banner saying to "re-authenticate in Settings and try again". Settings has no
  standalone re-auth action: the only thing that stamps `last_fresh_auth_at` is starting an API-token
  creation and being refused first. So the advice led nowhere, and no sequence of clicks in the app
  could revoke a device. Found while trying to delete six retired runner hosts.

  The revoke control now owns the second step itself — confirm → password → `POST /api/auth/reauth`
  → retry the same revoke — mirroring what the tokens tab already did. `isFreshAuthError` moves out
  of that tab into `features/auth/fresh-auth.ts` so both surfaces share one definition rather than a
  copy, and `useRevokeDevice` stays silent on that 403 instead of toasting a failure next to the
  prompt that is in fact the next move. The misleading banner is deleted rather than reworded.

  Superseded the same day by the entry above: the password step it added is one an OAuth-only owner
  can never complete, so it did not fix the case it was written for.

- Keyboard focus is visible again on the selected segment of every SegmentedControl and on the
  project cards in the Projects console (ISS-843). Both painted an elevation `shadow-*`, and in
  Tailwind v4 a utility-layer `box-shadow` beats the `@layer base` `:focus-visible` ring that
  globals.css gives everything else — so those two controls kept their shadow and lost their ring,
  with `outline` already suppressed app-wide. Measured on `/kit` 2026-09-05 by tabbing all 47 stops:
  the selected segment computed only `rgba(24,27,34,0.05) 0 1px 2px`, no ring; a ProjectCard clone
  computed only its two elevation layers. Both now re-declare `focus-visible:shadow-[var(--shadow-focus)]`.
  `design/focus-ring.test.ts` locks it: no `<button>`/`<a>`/`<Link>` may carry an unconditional
  elevation shadow without a `focus-visible:shadow-*`, and the base-layer ring must stay in
  `@layer base` (unlayered, it would beat every per-component ring instead).
  ISS-843 was filed against Toggle's unchecked state; that one does not reproduce — an OFF Toggle
  declares no shadow utility, so it inherits the base ring and computes
  `rgba(45,91,214,0.2) 0 0 0 3px`. Checkbox unchecked is the same, and Radio declares its ring
  outright. The reported symptom was real, but it was on two other components.

- A memory write under a new `sourceRef` no longer destroys an unrelated note, and the forge-dev note
  store no longer lies about which day it holds (ISS-876, superseding closed ISS-861). The near-identical
  dedup absorb was unreachable for a refinement of an existing record — `findNearDuplicate` returns null
  on an exact-key hit — and reachable ONLY for a write under a brand-new ref, precisely the case where
  the caller has stated this is a NEW record. It then redirected that write onto a row nobody had named.
  On forge-dev it overwrote 4 of 6 dated summary rows across two unrelated schedules, and the
  `supersededSnapshotRef` it handed back pointed at a row inserted with `archived_at` set, which every
  read surface filtered out — the agent that caused the loss was given an id it could not dereference.
  The probe now only REPORTS (`nearDuplicateOf` + `dedupeScore`) and the write always lands on the ref
  the caller named; refining another record means re-issuing the write under that exact key. Snapshot
  rows already minted stay reachable through `forge_memory.get`/`GET /api/memory` with
  `includeArchived: true`, every row carrying `archivedAt` so a recovered one is never read as live.
  The code shipped on 2026-08-30 in `68946d5e3` and this entry is its record — it went in unlogged.
  The data repair is new: 16 summaries that survived only in an archived row now live at a ref of
  their own (`dream-daily-review-2026-08-03` … `-08-25`, `doc-sync-2026-08-17`), three squatted refs
  hold their own originals again, and `dream-daily-review-2026-07-15` — the one whose original was
  never archived at all — says so instead of answering with 2026-08-24's summary.

- `GET /api/memory?sourceRef=…` filters by that ref instead of returning the whole store (found while
  repairing ISS-876). `runMemoryGet` has always supported the filter, but `listQuerySchema` never
  declared it, so `zValidator` stripped the key silently: the response carried every row in the project
  with `total` counting all of them and no error, which reads as a match unless the caller checks the count.

- The embedding backfill also re-embeds knowledge entries (found while shipping ISS-907). A knowledge
  entry saved during an embeddings outage was stored without a vector "for backfill", but the
  five-minute sweep only read memories, so the entry stayed keyword-only until its body changed; on
  forge-beta 16 entries across four projects sat that way. The sweep now takes knowledge entries after
  memories, embedding the same text the save would have.

- The reranker is shown 1,500 characters of each candidate instead of 600 (ISS-914). A chunk passage
  runs to about 1,400 characters, so at 600 the model ranked a passage by its opening and demoted the
  exact hit on 8–13 of 40 tail-fact questions per project; at 1,500 it does so on 2–8, and the true
  hit is first on 5–22 points more of them (six projects, 2026-09-05). Nothing else about rerank
  changes.

- The fleet feedback digest silently under-counted the backlog. `forge_feedback action=list` is
  capped by response SIZE, and the digest made one call and reported whatever came back — two runs
  an hour apart over the same data said "≥91 across 11 projects" and "42+ across 10", and only the
  first had happened to enumerate. It now narrows by target, then severity, then kind, then project
  until every cell returns `hasMore:false`, reports the total as a floor rather than a count, and
  names any cell it still cannot page past.

- The fleet feedback digest no longer files a near-duplicate issue every week. Its create call now
  carries a fixed `detectorKey`, so the kernel keeps at most one open digest and later runs comment
  on it instead of filing again. It had been deduping by asking the agent to read the backlog for an
  overlapping window first — the same prose rule that produced 7 near-identical drafts on the daily
  sweep, and the first real digest run filed with no key at all.

- A scheduled run that died mid-flight recorded a disposition it never got, and its lost window
  went unreported (ISS-875). The failure classifier's reason is a class *and* a predicted
  disposition — `usage/session limit → cross-device failover` — and the schedule path stamped both
  onto the row before the failover ran, so the row asserted a cross-device failover whatever came
  back. Two things now hold. The refusal to re-run a session that may already have committed work
  lives in `redispatchScheduleSessionOnFailover` itself rather than in one caller's `WHERE` clause,
  so a session that attached with anything but a proven `toolCallCount: 0` is refused whichever
  caller reaches it — previously the second caller had no such predicate, and only the absence of a
  free device stopped the 2026-08-28 Dream run creating its issue twice. And the attempt writes the
  disposition it actually settled on back over the prediction, keeping the class and replacing only
  the clause after the arrow: `no failover (session had attached and run tool calls; side effects
  preserved)`, `no failover (no other device was available)`, or the device a real re-dispatch
  landed on. A run abandoned that way now raises a `schedule_report` warning at the operator,
  because the recovery the old comment named — the next cron firing — does not exist for a schedule
  whose prompt scans a fixed trailing window: that day's review is simply never written.

- The driver was told a stage that never runs would write its changelog line (ISS-910). The
  injected `release-notes-format` fact said *"forge-release appends this to the changelog at
  close"* on every stage it applies to, including `drive` — where nothing dispatches after the
  driver. Neither backstop catches the gap it opens: the close is gated on `releaseNotes` being
  set on the issue and never on `CHANGELOG.md`, and `check-release-record.mjs` is a
  no-silent-loss ratchet, so an entry that was never written was never lost. The sentence now
  forks on the stage, the way the same fact already forks for the transport, and tells a driver
  that no later stage appends it — the changelog line, on a project that keeps one, is its own.

- A job whose only claimable box was rate-limited burned all thirty retry attempts instead of
  holding. The claim floor that requires a runner able to name its agent (`0.11.0`) was enforced in
  TypeScript at the claim and nowhere in SQL, so `onlineCapableDeviceIds`, `fresh_capable_runners`
  and the picker all counted a below-floor box as a healthy device. The retry engine therefore
  believed a usable device existed, never reached `all_devices_exhausted`, and rotated onto a box
  whose every claim core refused with `runner_too_old`. The floor is now one predicate
  (`claimCapableSql`) that both halves read, so a box that cannot claim is invisible to selection
  and an all-limited fleet defers on the self-clearing hold as designed. Found on epodsystem on
  2026-09-05, the day the floor shipped with only one half.

- A fleet whose runners are merely out of date no longer reports itself as offline. The dispatch
  gates gained a `runner_too_old` reason, ordered ahead of `runner_stale` so it is reachable, and the
  capacity notification, the waiting-reason copy and the attention chip all name the real condition:
  the host is online with a green heartbeat and only its build is below the floor the claim enforces.
  Unlike a rate limit or an offline host, this one never clears by itself, so it is marked as needing
  action and the next step names the runner update. Previously an operator was sent to a Runners tab
  where everything looked perfect.


- The master swept every 30 seconds while its account was rate-limited, spending a pass a minute on
  work it could not start. `GET /api/devices/me/runners` now reports the remaining seconds on the
  limit and the reason, and the master stretches its poll to at most five minutes when *every*
  project it serves is limited — one limited project never slows a healthy sibling. This is a
  backoff and deliberately not a skip: core clears a limit only when a job succeeds, so a master
  that stopped sweeping would remove the only thing able to clear the stamp.

- **A session's `/agents` row no longer blames the box for a death it did not cause.** A queued job
  whose box was busy with the shared checkout posted nothing while it waited, so the 120-second claim
  hop failed the session `queue_timeout`; the job was then reaped `session_lost` *because* its session
  was terminal, and the mirror that copies a job's outcome back onto its session overwrote the cause
  with that consequence. Measured on epodsystem 2026-09-05: 61 of 84 failed sessions read
  `session_lost` (origin `transport` — "the runner went quiet") while `kernel_transitions` held
  `queue_timeout` for every one of them, written 90 seconds earlier. Both halves are fixed. The mirror
  refuses to overwrite a reason already on the row when the job's error is a sweeper marker
  (`session_lost`, `dispatch_unclaimed`, `stale`) — a real diagnosis arriving from the job row, such as
  `provider_spend_cap`, still lands, so ISS-877's recovery is untouched. And the runner starts its
  pre-spawn heartbeat *before* it waits for the repo lock rather than after, so a job queueing behind
  a busy root reports what it is actually doing instead of looking dead. That wait is now bounded too,
  and the heartbeat's budget is derived from the same deadline with a compile-time assertion, because a
  runner that gives up after core condemns spawns an agent under a job that has already been retried
  elsewhere.

- **A claim no longer keeps a hold the reaper can undo underneath a running agent.** Claiming a job
  stamped it onto the box but left `held_by` set, and the master-hold reaper — whose session-less arm
  judges by `held_at` age alone — then unwound that stamp back to `queued` with `device_id` NULL while
  the agent was still running. Everything that agent posted came back 403, and the flush loop simply
  logged and tried again, at two requests a second with no ceiling: measured on epodsystem 2026-09-05
  on jobs `f7f4bce4` and `8b8b7be4`. It needed no dead master — a healthy one whose `runner.start`
  blocks past three minutes, which `dispatch.rs` documents as ordinary, reaped its own work. The stamp
  now ends the hold in the same statement, so a claimed job is not reachable from any release path,
  and the three paths that drop a hold drop the hold alone. A daemon that dies between that commit and
  the spawn now leaves `dispatched` + unacked + unheld, which the loop monitor already chases — the
  shape it replaces was recovered by nothing.

- **A runner stops posting to a job core no longer routes to it.** 403 and 409 on `POST /jobs/:id/events`
  now share one name, `JOB_DISOWNED`, and the consumer breaks out on it instead of logging and
  retrying forever; it makes no lifecycle call either, since those 403 for the same reason. The agent
  process is left to exit on its own — it is a one-shot child, not a resident session `close` can
  reach — so the box reads one slot freer than it is, which is bounded and is strictly better than a
  slot held forever behind an endless retry.

- Retrieval v3 rerank on a chunked project (ISS-913). The fast model is now shown the passage that
  matched the query, not the first 600 characters of the whole memory, so a fact found deep in a long
  issue is no longer pushed down the list by a reranker that never saw it. The rerank cache is keyed on
  the same text. Flat projects are unchanged.

- **Chat turns no longer queue for a duplex session permit.** A chat turn waited for one of the
  box's session permits, and the wait had no timeout. Queued behind parked pipeline sessions it was
  killed by core's 90s `no_client_ack` sweeper — measured on forge-beta session `1af837da`
  (2026-09-04): five user messages, `agent_startup_failed`, not one assistant reply.

  The exemption is by name — `JobSpec.counts_against_session_cap` is false for chat and true for a
  duplex pipeline job — rather than inferred from something that differs between them by accident
  (`issue_id`, `pat_token`, `step`). A new caller that leaves it false spawns processes nothing
  bounds, which is why the field is explicit and the predicate has its own test.

  `[runner] chat_max_concurrent` is retired. The number it carried now sizes `duplex_max_sessions`,
  which counts live duplex PROCESSES for pipeline jobs only; an old config still loads and warns
  once, naming the new key.

- **The cc-startup signal counts assistant turns again.** `deriveCcStartupSignals` fed
  `pipeline/failure-classifier.ts` a threshold written as "≤3 assistant messages" while counting
  every `stdout` ROW. `--include-partial-messages` (ISS-479) had already broken that equivalence —
  one assistant turn emits six to ten rows — so the immediate-failover class it exists to catch
  had quietly stopped firing. It now counts `line.type = 'assistant'`, which also makes the signal
  independent of which frames the change above stores. Proven against real Postgres, since the
  unit suites mock the query away.

- **Chat send stopped 500'ing on every project.** Migration 0200 dropped `runners.host` when the
  remote runner lane was removed, but the two device picks in `lib/device-pool.ts` are hand-written raw
  SQL strings, so nothing that runs on a change — not tsc, not the 5,276 unit
  tests, whose `device-pool.test.ts` mocks `db.execute` and cannot represent a missing column — saw
  `AND r.host = 'device'` outlive the column. Every `POST /api/agent-sessions/send` and every
  chat-capable runner check answered `INTERNAL_ERROR` / `column r.host does not exist` on
  forge-beta from the deploy of 2026-09-04 until this. The clauses are gone (and with them
  `AND r.device_id IS NOT NULL`, dead since the column went NOT NULL in the same migration), and
  `tests/integration/device-pool-schema-e2e.test.ts` now runs both picks against the migrated
  schema, so the next dropped column fails there instead of in production.

- **A trunk-based project can declare a release gate.** `hasProduction` asked one question — is
  `productionBranch` different from `baseBranch`? — as a proxy for "is this prod binding a release
  target or just observability". It reads the wrong thing on a project that does not ship by
  promoting a branch: pixelight publishes a storefront theme, so its two branches are identical by
  nature, and it could not declare a gate at all while 8 merged issues sat at `released` with no
  step that reaches them. The declaration is now either half: a distinct production branch, OR
  `releaseRunnerLabel` on the binding — the operator naming the box that ships it, which an
  observability binding has no reason to carry. Everything downstream already handled this shape
  (`releaseBranches` returns `productionMergePlanned: false` and the default procedure's merge step
  is conditional), so nothing else changed.

  Provider identity is deliberately NOT the discriminator: forge-dev carries an epodsystem prod
  binding for the storefront MCP on a trunk repo, and reading the provider as a release target
  would have gated this repo's own closes. Verified across all 31 live projects — only sidpeak
  (which already had a gate through its branches) and pixelight carry a release label, so no
  project's close behaviour changes as a side effect.

- **A release runner can now be declared on any production binding, not just Coolify.** The batch
  release reads `releaseRunnerLabel` / `verify` / `rollback` off the project's oldest active `prod`
  binding whatever its provider, but only the `coolify` and `agent` config schemas carried those
  fields — so on a project bound to a storefront, an API workspace or Sentry, the PATCH that names
  the release box returned 200 and silently dropped it (zod objects drop unknown keys), and the
  settings roster then reported the label as undeclared with no way to fix it. Every provider schema
  now spreads them and lists them binding-tier, so which box releases stays the project's answer
  even when the credential is shared across the org. Found on pixelight, where `base ===
  production` hid the gap behind the earlier refusal.

  An `agent` binding also stopped borrowing Coolify's config schema on PATCH: `configSchemaForProvider`
  had no `agent` branch and fell through to it, which quietly accepted a `baseUrl` and deploy
  `targets` for a channel that has no adapter to use them.

- A runner limit now reaches **every binding of the box that hit it**. One daemon holds one agent
  login, but `runners` carries a row per (device × project) and the stamp was scoped to the row that
  happened to run the job — so a box whose OAuth session had died was marked dead on one project and
  read perfectly healthy on all the others, which kept dispatching into the same dead session.
  Measured on forge-beta 2026-09-04: three devices in exactly that state, with 7, 1 and 1 sibling
  bindings clean. `auth` carries no reset time, so nothing self-healed it — the shape that burned 421
  jobs in 5.5h on dev1-ai013. The clear travels the same way, so one successful job un-sticks the
  whole box; a binding's own `lastError` (a missing repo path, a preflight failure) stays local,
  because that one really is per-project. Existing split-brain rows correct themselves on the first
  failure or success on that device after this deploy.
- `LITELLM_API_URL` was read two ways. The chat adapter appended `/v1/chat/completions` to it
  and `memory/llm.ts` appended `/chat/completions`, so the same value could not be right for
  both. LiteLLM answers on both paths, which is why it never showed; on a proxy that serves
  only `/v1/...` every agent-session auto-title and memory extraction 404'd and came back
  `null` while chat worked on the same variable (measured 2026-09-04). Both readers, and the
  Anthropic adapter, now build the URL through `lib/openai-compat-url.ts`, which takes the
  host with or without a trailing `/v1`. The env examples say so.

- Four defects the chat tool layer showed when a real model drove the real `forge_*` toolset
  against a live database (2026-09-04, Gemini and GPT through one proxy, both wires):
  - `forge_issues get` refused `ISS-3`. The tool prints `issueId: "ISS-<n>"` beside the UUID and
    both models reused the short id, which `documentId: z.uuid()` rejected, so neither could open an
    issue it had just listed. `chat/tools/issue-ref.ts` rewrites `ISS-<n>` to the UUID inside the
    bound project before the handler parses, and the tool's chat description says so.
  - `forge_projects_get` was offered and always failed `FORBIDDEN_SCOPE`: the synthetic chat
    principal carried no scopes and that read handler checks for `read`. It now carries `read` and
    only `read`; the allowlist's per-action gate, not the scope, is what bounds chat writes.
  - Gemini decorated a call with a `reason` key on a tool whose only parameter had been stripped
    from the advertised schema, and the `.strict()` handler rejected the whole call. Undeclared
    top-level keys are now dropped against the tool's own schema before dispatch.
  - A handler that threw a Drizzle query error showed the model 500 characters of INSERT and
    never the Postgres reason; the thrown error's `cause` now wins when there is one.
  - The ISS-687 dedup guard let a second report of the same Safari login bug through as ISS-7:
    its title scored 0.727 against the draft filed one turn earlier, above the 0.72 floor, but
    two model-written descriptions of one chat message share little vocabulary and the 25%
    description weight dragged the blend under. A title that clears the floor alone is now a
    duplicate; the blend still rescues a weaker title with a near-identical description. Because
    word overlap cannot tell that apart from two issues about different screens — "Dark mode
    broken on the settings page" against "…on the profile page" scores 0.750, above the floor the
    real miss sat below — the rejection now names `data.confirmNotDuplicate`, which the guard
    consumes to let a create through. A false positive costs one round instead of being
    unrecoverable in the turn.

- web-v2 `features/activity` read `chat_logs.usage` through Anthropic-shaped snake_case keys
  (`input_tokens`, `cache_read_input_tokens`) that core has never written, so `sumTokens` returned
  0 for every row. `ChatLogUsage` is now the shape `run-turn-core.ts:usageForLog` writes
  (`promptTokens`, `completionTokens`, `totalTokens`, `cachedPromptTokens`, `elided`); the module
  header named a `activity-feed.tsx` that does not exist and now says what is true — no screen
  renders the feed today. The `intent` list parameter went with the endpoint's filter.

- **The system-job fast model stopped losing its whole token budget to the model's own thinking.**
  Measured against the live proxy on 2026-09-04 with `gemini/gemini-2.5-flash`: `max_tokens` covers
  REASONING tokens first, so the real `TITLE_PROMPT` at the real `TITLE_MAX_TOKENS = 24` spent 20
  tokens thinking, emitted 0 text tokens and returned `content: null` — every agent-session
  auto-title has been a silent no-op — while memory extraction at 400 spent 382 and returned JSON
  truncated mid-object, which `parseExtractionOutput` drops with `catch { return null }`. Raising
  the constants does not fix it: reasoning scaled to fill 24, 64 and 128 alike, all three
  `finish_reason: length`. `callLiteLlm` now sends `reasoning_effort: 'none'`, the only one of five
  probed spellings the proxy honours (`thinking: {type:'disabled'}` and `reasoning_effort: 'low'`
  do not), after which both budgets pass unchanged — the title fits in 24 and extraction parses at
  400. Because the helper is documented as working against ANY OpenAI-compatible endpoint, an
  explicit unsupported-parameter 400 retries once without the field.

- **A fast model that ran out of budget says so instead of returning the same `null` as a model
  with nothing to say.** `callLiteLlm` returned a bare `null` for three different things — no
  backend, HTTP failure, and budget exhausted mid-answer — and every caller's `if (!raw) skip`
  read all three as "nothing to extract". That is the ISS-726 shape exactly: `fastModelConfigured()`
  returns true, so no gate fires, and the feature is dead with clean logs. An empty body with
  `finish_reason: 'length'` now retries once at a larger budget and, if still empty, logs the
  finish reason and the budget. `llm.test.ts` asserts the handling rather than the constants,
  because a mock cannot represent reasoning eating a budget but can represent the response shape
  it produces.

- **A tool-hungry chat turn no longer throws away eight rounds of work and answers with nothing.**
  `runTurnEvents` finalized on the round that hit `MAX_TOOL_ITERATIONS`, taking that round's text as
  the answer — but a round that requests tools has no text, so the turn returned `''` with
  `terminal: 'done'` and `errorMessage: null`. Three things followed from one bug: `chat_logs` wrote
  a burned turn as a clean success (`reply: null, error: null`), the capped round's tool calls were
  collected and dropped so an `escalate` requested on the last round was invisible to the Rocket.Chat
  caller that greps `toolCalls` for it, and the SSE client got `tool_call` events with no
  `tool_result` to answer them. The cap now means what it says — at most 8 provider
  round-trips, the last of them invoked with NO tools, so the model is asked for an answer rather
  than offered work it has no round left to do. The count of executed tool rounds is unchanged at 7;
  what changed is that the eighth is spent on prose instead of being discarded. Note what this does
  NOT do: a last-round `escalate` is not made visible, it is made unreachable — round 8 carries no
  tool schemas, so there is nothing left to request with. Nor can withholding tools compel prose, and a model that
  requests one anyway on that round is now dropped rather than forwarded: nothing can execute a call
  made against an empty toolset, so emitting it would hand the SSE client the same `tool_call` with
  no `tool_result` that this entry is about, and counting it in `toolCalls` would tell
  `external-chat.ts` an `escalate` ran when none did. An eighth round that returns nothing now
  records the model's empty answer as the model's, which is a different fact from the loop
  discarding a full one.

- **An OpenAI-compatible endpoint that delimits SSE frames with CRLF is no longer a silent empty
  reply.** The parser found frame boundaries with `indexOf('\n\n')`, which cannot match
  `\r\n\r\n` — so against a proxy that rewrites line endings every frame buffered to EOF and was
  then discarded, and the turn terminated `done` with no text, feeding straight into the bug above.
  The comment above it claimed the parser would "tolerate stray `\r` from upstream proxies"; it
  stripped `\r` inside a frame it had already found and did nothing at the boundary. A boundary is now
  any two consecutive line terminators, each independently CRLF, CR or LF: the mixed forms
  (`\n\r\n`, `\r\n\r`) are legal SSE that a regex over only the three symmetric spellings still
  glues together, with the same silent-empty-turn result one layer down. The bare-`\r` branch
  carries a `(?!\n)`, without which the engine backtracks a failed `\r\n` into `\r` + `\n` and
  accepts ONE internal CRLF between two `data:` lines as a boundary — splitting a multi-line frame
  in half, both halves failing `JSON.parse`, both dropped, and only ever under CRLF. A frame that arrives without its trailing blank line is flushed at stream end instead of
  being dropped, and the body is now `cancel()`ed rather than merely unlocked — on the `[DONE]`
  break it was left unread, holding its connection out of the pool.

- `EMBEDDINGS_FALLBACK_MODEL` and `EMBEDDINGS_TIMEOUT_MS` are declared on the `core` service in
  `docker-compose.prod.yml`. `config/env.ts` has always read both, but with no `${VAR}` line the
  Coolify UI could not reach them — the same silent no-op as the `RATE_LIMIT_PAT_*` entry below.

- **Both `.env.example` files describe the variables the code actually reads.** The root one had a
  section headed "AI / embeddings" that listed only `LITELLM_*` and not one `EMBEDDINGS_*` key,
  which tells an operator embeddings are covered when in fact memory then writes keyword-only rows
  forever and semantic search never runs — a degradation the code takes deliberately and silently.
  `packages/core/.env.example` had the mirror gap, documenting `EMBEDDINGS_*` and no `LITELLM_*`.
  Both now say that these are two independent settings that may point at one proxy, and note that
  `EMBEDDINGS_DIM` must match the pgvector column.

- `RATE_LIMIT_PAT_MAX` and `RATE_LIMIT_PAT_WINDOW_MS` are declared on the `core` service in
  `docker-compose.prod.yml`. Coolify injects variables through `${VAR}` in `environment:`, not through
  `env_file`, so setting either in the Coolify UI did nothing until now: one user lost four tokens in
  a day to the 60/min default and its three-breaches-an-hour auto-revoke, with no reason shown.

- Aborting a release batch now cancels the run and every job under it. `abort` used to release
  the claims and stop there, leaving the run `running` and its job alive: sidpeak batch `ee39c4ae`
  (2026-09-03) was aborted while its retry job kept going, shipped 20 commits to production, and
  then `finish` found no claims and closed 0 of 12 issues; batch `edfd569d` was aborted and left a
  `queued` retry under a still-running run. The route now goes through `closeRunIfOneShot`, which
  is the cascade-calling helper the orphan invariant requires.

- The three release-batch lifecycle routes (`GET`, `finish`, `abort`) answered 500
  `RELEASE_BRANCHES_UNDECLARED` for a project with no `baseBranch`, because the ownership check
  computed the whole release plan. Ownership is now a plain run lookup; only the context route
  needs the branches, and it answers 409 with that code. `54cd78d9` shipped this red on all three
  integration tests and on `release-batch-run.test.ts` — a green `pnpm verify` is not a green CI,
  again.

- `releaseRunnerLabel`, `verify` and `rollback` on a **coolify** production binding were silently
  dropped: the coolify config schema did not know the keys, zod strips unknown keys, and the PATCH
  returned 200 while the roster kept reporting the label as undeclared. The three fields are now
  shared between the `agent` and `coolify` schemas and live on the binding tier, so a project admin
  can declare them on an org-shared connection without touching the credential.

- **A duplex job could be reaped as dead while it was only waiting for a session slot.** The
  runner's session heartbeat starts when the Claude process spawns, but `start` can block for
  minutes before that: a duplex job waits on the per-device session semaphore, and a session parked
  at `awaiting_input` keeps its permit until its residency deadline. Core reaps a silent session at
  three minutes and, when the kill probe comes back `not_found` (nothing spawned yet), fails the
  job as `session_lost`. sidpeak's release batch on 2026-09-03 (job `483387d4`) waited 4.5 minutes
  for a permit after ack and died exactly that way, leaving its run `running` with no job and
  twelve claims held. Runner 0.10.4 heartbeats from ack until `start` returns, and logs when it is
  waiting for a slot instead of going quiet. Still open: core dispatches against the runner's job
  cap, not its session ceiling, so a device full of parked sessions is offered jobs it cannot start.

- **A pinned plugin designation was never actually pinned.** Three defects stacked, found the
  morning the fleet was switched on (2026-09-03) — every box installed `forge` at whatever
  `forge-plugin` master happened to be, while the runner logged the pin as applied.
  1. `claude plugin marketplace add` clones at depth 1, and the runner's fetch-before-pin was
     `git fetch --all --tags`, which on a shallow clone moves only the branch tips — a pinned SHA
     that master had moved past was never fetched (`reference is not a tree`). Runner 0.10.1
     fetched the SHA by name, and that was the whole of 0.10.1; it was not enough.
  2. `claude plugin install` **re-clones** a github-source marketplace even when the plugin is
     already installed (measured on claude 2.1.241), so the checkout the runner had just made was
     replaced by master before the install ran. A pin applied to a directory the CLI owns cannot
     survive the CLI's next verb.
  3. The step meant to move installs onto the pin ran `plugin update <name>`; the CLI wants the
     qualified `<name>@<marketplace>` and answers "not found" to the bare form, so it had never
     done anything.

  Runner 0.10.2 changes who owns the clone. The runner keeps a full clone per marketplace under
  `~/.config/forge-runner/marketplaces/<owner>__<repo>`, checked out to the pin (or to
  `origin/HEAD` when unpinned with `autoUpdate`), and registers **that directory** as the
  marketplace — the CLI then has nothing of its own to re-clone, and `install`/`update` copy
  whatever the clone has checked out. A box that already carries the CLI's github-source
  registration for the same repo is migrated on the next sweep: `marketplace remove` (which
  uninstalls its plugins), `marketplace add <dir>`, reinstall. Verified by hand on ubuntu3 before
  the code was written: install at the pin lands `gitCommitSha = 612f6bb`; moving the clone and
  running `plugin update forge@forge-local` follows it; re-running `install` leaves the clone alone.

  0.10.2's first sweep on the owner's own machine then showed the last gap: `marketplace add`
  silently **replaces** a same-name marketplace, and the operator's dev checkout of `forge-plugin`
  was registered under the very name the repo's `marketplace.json` claims. Runner 0.10.3 reads that
  name from its clone first; a directory the operator registered under it outranks the server
  designation on that device — the same precedence `merge_targets` already gives a local target —
  and the sweep says so instead of taking it over.

- **The autonomous driver was handed the staged pipeline's rulebook on every job.** Two blocks are
  injected into every dispatch rather than fetched on demand — `PIPELINE_RULES` and
  `TOOL_REFERENCE` — and both were written for a lane the driver does not run in. What reached it
  was a nine-rung status ladder this mode does not have, instructions to park at `waiting`,
  `reopen` and `on_hold` (the three `issues/autonomous-park.ts` rewrites at write time, so the net
  built to catch a mistake fired on every session that followed the prompt), a "check in first"
  rule pointing at `forge_step_start`, and a full MCP tool catalogue — handed to a shell holding
  `$FORGE_PAT` and no MCP client. The four prompt sites fixed a day earlier emitted zero `forge_`
  for a drive job while the preamble in the same context window named eleven tools.

  **Correction to the sentence above and to `208fb2f0`:** "no MCP client" is wrong and is left
  standing rather than edited away, because it was published. The driver has one, and always did —
  376 `forge_phase` and 137 `forge_step_start` device calls in the three days to 2026-09-02, every one on an autonomous project, and `forge_phase` has no caller but the
  driver. The fork is not a reachability fix. It rests on two things that survive the correction:
  the staged content is wrong on any transport, and a skill and a preamble read in one context
  window must name ONE way to reach Forge. Which one moves is a choice, and the CLI won it because
  the job PAT is minted per job, scoped to one project and revoked at terminal where the device
  token behind the MCP path is long-lived and fleet-wide. Every guard that stated the false version
  has been rewritten.

  The connected-integrations block is the deliberate exception and was checked rather than forked:
  `forge_storefront_target` has no REST route at all, `mcp__epodsystem__*` is a third-party server
  the runner injects, and the driver's MCP client reaches both. Forking that block would have
  broken storefront work on a drive job.

  `prompt/facts/drive-rules.ts` is the lane's own document, not a filtered copy: a staged rule
  earns a place in it only when the driver would act differently having read it. The ladder, the
  parks, five-rounds-then-`waiting` and the tool catalogue fail that test and are dropped rather
  than translated; the crash contract, `merged_at` verification, branch and shared-tree discipline,
  "never speak for a human" and the learning-capture loop pass it, and are stated in
  `forge-runner api` terms. `mandatoryPreambleBlocks(step)` is the fork, and it returns the staged
  constants byte-identically so the shared prompt prefix every staged job sends is unchanged.

  Two contextual facts reached `drive` and were wrong there for the same reason.
  `release-notes-format` named `forge_issues.update` — not cosmetic, because
  `RELEASE_RECORD_REQUIRED` refuses an agent close while `releaseNotes` is null, so the one
  instruction that clears the driver's own exit gate was a call it could not make. And the worktree
  pair applied to `code`/`fix` and `release` respectively, none of which exists in this mode: the
  job that runs unattended for an hour in a tree other agents are using had no worktree protocol at
  all, and nothing ever asked it to remove what it created.

  `project-config` and `project-context` fork too, and the first is the sharpest fix in the set: its
  `noProgressRounds` line told the driver to stop by setting `waiting` — the park
  `issues/autonomous-park.ts` rewrites to `needs_info` for a device actor — so the prompt instructed
  the exact move a net exists to catch, on the only job type that runs unattended for an hour. That
  one survived every unit assertion and was found by reading the assembled preamble off the live
  deploy through `POST /api/prompts/preview`; the regression test now runs that route.

  `check-injected-doc-modes.mjs` now reads the new file. It has to: its own guard says a surface
  the gate does not list is injected text nobody checks, and the drive rules live outside
  `facts/registry.ts` only because that file is at its 500-line budget.

- **A `drive` handoff was not code evidence, so the driver could not stamp its own merge.**
  `collectWorkEvidence` scanned `('code','fix')` on both the job table and the handoff table, and
  `drive` is the step that writes the code, merges it and closes the issue in one session — its
  handoff schema carries `commitSha` and `filesModified`, the two fields `hasCodeEvidence` reads.
  `applyMergeMarker` refuses an agent's `POST /api/issues/:id/merge` with `NO_WORK_EVIDENCE`, and
  the close-stamp audit comment told every reader "no branch, commit or code handoff is recorded"
  for work that had all three. Measured on forge-beta 2026-09-02: 7 stored `drive` handoffs, 7 of
  them carrying a `commitSha`, 0 counted. The unit suite could not have caught this — it queues
  rows behind a fake query builder that never executes a `where`, which is exactly what an
  `inArray` list is — so the regression test runs the real SQL.

- **Core's own prompt told the autonomous driver to use MCP**, against a bundled skill that names
  no MCP tool at all — the two are read in one context window and the agent believed the prompt.
  Measured on `mcp_audit_log`: 4,806 `forge_step_start` and 4,268 `forge_step_handoff.write` calls
  from agents, every one on an autonomous project, whose shell holds `$FORGE_PAT` and has no MCP
  client. Four sites, all forked on `drive` rather than rewritten, so a staged prompt comes out
  byte-identical: the drive dispatch prompt, the fetch-via-tool pointer, the termination block and
  the injected step-handoff fact.

  The staged termination block was wrong for the driver in a third way beyond the tool names. It
  sent the agent to "the next state in the Pipeline Rules ladder", which this mode does not have,
  and offered `waiting` and `reopen` — the two parks `issues/autonomous-park.ts` rewrites at write
  time. Instructing them made a net built to catch a mistake fire on every session instead. The
  driver's block names neither, and states no ladder: the skill's five-status table is the single
  declaration, and `check-autonomous-transitions.mjs` already gates it.

  `jobType === 'drive'` is the lane, not a heuristic: `autonomousStepFor` is the only producer of
  that type, `dispatchDriveManual` is reachable only behind `isAutonomous`, and `stageEnum` on
  `POST /api/issues/:id/run-pipeline-step` excludes it.

- Removed `userPromptPolicy.handoffs.requireHandoffWrite` and `.missingMarkerPolicy`. Both resolved
  a default on every prompt build and no code read either. The comment above them described a
  `POST /api/jobs/:id/complete` check that fails a job for a missing handoff row or a missing
  `DONE` marker; no such check exists — the axis-separation decision removed it, and the one place
  that still reads a handoff (`jobs/finalize-done.ts`) does the opposite, rescuing a job the runner
  called failed. 0 projects set either, and no UI, contract or doc referenced them. The schema is
  `.strict()`, so a config still sending one is now rejected rather than silently ignored.

- `POST /api/issues/:id/comments` stamped no `is_ai` at all, so an agent's comment took the column
  default and landed `is_ai = false` with a NULL `author_device_id` — the exact tuple the
  `comments.is_ai` guard defines as a human. Measured against the deploy with `forge-runner api`.
  The MCP tool labels every write `true` because that path is automated by construction; this route
  serves a person in a browser and an agent holding a job PAT through the same door, so the value
  now comes from the caller's agency. Migrating agents onto the CLI would otherwise have grown the
  count of agent comments rendering as people's in step with the migration.

- `docs/architecture/data-plane-surface.md` told a reader to call `forge-runner api issues` and
  `/api/comments`. Both 404: neither router has a collection route. The issue list is
  project-scoped (`/api/projects/:id/issues`) and a comment is created at
  `/api/issues/:id/comments`.

- A failed agent session now says what killed it. Every agent-side death was recorded as
  `job_failed` — one token covering an exhausted spend cap, an expired sign-in, an unreachable
  runner and an agent that exited with no result alike — so the only way to learn which had
  happened was to open the transcript. `agent_sessions.failure_reason` is now bound to a
  `FailureCause` enum on the column and the human sentence moved to a new `failure_detail`, which
  splits the two axes that were sharing one field; the session lane asks the same classifier the
  job lane already asked instead of writing a literal at the boundary, so a cause cannot be
  correct in one table and absent in the other. 99.93% of 10,904 failed jobs over 90 days land on
  one of 33 named causes, and the UI shows the label with the next action rather than a status
  word. Historic `job_failed` rows resolve at read time and were deliberately not backfilled —
  most no longer have a source to infer a cause from, and a guessed cause is a confident lie where
  the old token was at least an admitted one. They read as `unclassified`, which
  `forge_metrics.session_failures` counts as a first-class value rather than hiding, because that
  is the true measure of the period when nothing was classified at all. (ISS-877)

- A font host that does not answer can no longer take the backend deploy down with it.
  `layout.tsx` imported Hanken Grotesk and JetBrains Mono from `next/font/google`, which downloads
  the binaries while `next build` runs, and one Coolify application builds core and web-v2
  together — so on 2026-08-13 an unanswered font host exited the build, a core-only fix sat
  merged-but-not-live for about 90 minutes and needed a hand re-dispatch, and the failure was
  first misread as a defect in the diff being deployed. Both families are now committed as the
  exact variable woff2 Google serves for the `latin` subset and declared through
  `next/font/local`; the CSS variables and `font-display: swap` are unchanged, no
  `adjustFontFallback` override was needed, each SIL OFL licence ships beside its binary, and a
  test fails if the `next/font/google` import ever returns. Verified by severing egress through
  next/font's own proxy path — the build exits 1 on the merge-base naming the font fetch, and 0
  on the branch with both files emitted byte-for-byte, including from a container with no network
  device at all. One consequence worth knowing before reading a live page as a regression:
  `next/font/local` derives the generated `font-family` from the variable name, so the computed
  value now reads `hanken` / `jetbrainsMono` rather than a hashed `__Hanken_Grotesk_*`.
  (ISS-854)

- An agent's comment rendered as the person who owns the credential. `comments.is_ai` has recorded
  agent authorship on every write path since ISS-820, including the owner-lane PAT where
  `author_device_id` is NULL, but the comment tree never selected the column: the read path keyed
  the author off `author_device_id` alone, so `isAgent` only ever meant "came from a device token".
  The tree is now generic over its row type and `attachAuthors` demands `isAi`, which makes a query
  that forgets the column a compile error rather than a feed that quietly attributes agent writes
  to a human. The attach step also copies the resolved actor before marking it — `resolveActors`
  returns one object per actor, so the same person's hand-typed comments were one mutation away
  from being relabelled too. The actor vocabulary (`ActorRef`, `ResolvedActor`, `actorKey`) split
  into `issues/actor-identity.ts` so formatting a key no longer drags in the Postgres client.

- REST decided every caller was a person, so the evidence gates ran on `/mcp` and not on the CLI's
  own surface. `requireAuth` reduces a PAT principal to `principal: 'pat'`, a string tag, and four
  separate route sites then built a `{ type: 'user' }` actor by hand. MCP was safe by accident — it
  synthesizes a device for a PAT principal, and the gates keyed on device-ness — but REST has no
  device to synthesize, so `PATCH /api/issues/batch`, `PATCH /api/issues/:id/transition` and the
  manual step trigger all transitioned as a human. `/api/issues` is on the PAT allowlist, so those
  are reachable with any write-scoped token, and an agent holding one skipped ISS-786/812 entirely.
  Actors are now built in one place that carries the trust axis with them.

- The lifecycle gates asked whether the actor was a device when what they meant was whether the
  caller was a person. Four of them — the evidence gate, the agent-close hold, the release-record
  refusal and the autonomous park rewrite — now read `agency`, and two of those already argued the
  human-vs-agent case in their own guards while implementing device-ness. A job token makes the two
  axes differ for the first time: the write is its creator's, the caller is an agent. `actor.type`
  keeps answering who owns the write, which is what the two `actor_type` columns store, so no
  existing caller changes behaviour and no migration was needed. The five branches that genuinely
  mean "came from a runner" — WS room routing, the heartbeat, the orchestrator's `DeviceLite`, and
  the two readers of the stored enum — were left alone deliberately. What is NOT fixed is the
  stored half: agency is not persisted, so the activity feed will call an agent's write a person's
  once job tokens run. `docs/proposals/agency-is-not-persisted.md` prices that.

- A job's own access token authenticated as the human who owns it. Core mints one PAT per
  dispatched job under `jobs.created_by`, hands it to the runner and exports it to the agent as
  `$FORGE_PAT` — and `authenticatePat` stamped every PAT `agency: 'human'`, a constant. `agency` is
  the field the ISS-786/812 evidence gates read: `principalActor` maps a human PAT to a `user`
  actor, and both `checkTransitionEvidence` and `forge_issues.mark_merged` skip their evidence
  check for one. So the credential built specifically for agents was the single class exempt from
  the gates that exist because agents fabricate evidence. It is now derived from the `job:` name
  prefix, in the one place a PAT principal is built — that function serves `/mcp` and REST alike,
  since `beginPatRequest` calls into it, so the CLI surface is covered by the same line. Measured
  on production the same day: no job token has ever been minted, so this changes the behaviour of
  nothing that has run, and lands before the first one exists rather than after.

- `forge_issues.mark_merged` gated its evidence check on `principal.kind === 'device'` while the
  comment above it said it mirrored `checkTransitionEvidence`'s scope, which keys on the actor. The
  two neighbouring writes in the same file already went through `principalActor`; this one did not,
  so any agent holding a PAT — the agent-driven chat surface, and now a job token — could claim an
  issue was merged without the in-DB evidence a device is required to show. `merged_at` is what the
  feature-branch barrier reads to release every dependent, so the claim ships work ahead of its
  blocker.

- `POST /api/pat` accepted a hand-made token named `job:…`. The prefix is not cosmetic: it is how
  a user's PAT cap is counted, how a job's revoke sweep finds its token, and now how agency is
  decided. A token wearing it escaped its owner's cap, could be revoked by a job that never owned
  it, and would authenticate as an agent. The name is now refused on that route only — `mintPat`
  still accepts the prefix, because that is how a dispatch mints the real thing.

- Six MCP tools are back after being deleted the same day: `forge_orgs.list`, `forge_orgs.members`,
  `forge_skill_facts.list`, `forge_skill_facts.get`, `forge_metrics.project_retry_rescues` and
  `forge_metrics.session_failures`. Their removal claimed an audit-log split had shown no runner
  called them; the split was wrong. `mcp_audit_log.user_id` is filled in for a device caller too —
  it is stamped with the device's owner — so only `device_id` and `token_id` separate the two, and
  a count that leans on `user_id` reads every device call as a human one. Split correctly, all six
  had device callers, and the fleet hit a deleted tool at 09:07 UTC on 2026-09-01 and read
  `not_found`. `/api/skill-facts` is `requireAuth()`, which answers a device token 401, so the
  route was never a replacement for the callers that existed. The registered tool set is 59.
  The four tools removed before them stay removed, but not for the reason first given here: split
  the same way, `forge_metrics.step_durations` shows three device calls, not zero. All three are
  from June, nothing has called it in ten weeks, and the replacement a runner would reach for is
  `forge_metrics.project_step_durations` — still registered, device-reachable, and the name the
  one skill that mentions this metric actually tells an agent to call. `forge_skills.pin` and
  `forge_ux_improver` are at zero device calls; `forge_steer` never appears in the table at all.
  The extraction that commit also did is kept — `metrics/session-failures-report.ts` remains the
  one place the report is shaped, and the restored tools delegate to it instead of shaping it again.

- The MCP fence that keeps a project-bound access token inside its project is now tested. It had
  no coverage at all: every existing test built an unbound token, so the branch had never executed
  once. It is the only thing stopping fourteen tools — a token reaches them with a synthesized
  device identity, and their handlers read only the owner, never the token's binding. Removing the
  fence now turns four tests red, and one of them shows the query reaching the database on a
  project the token was never granted.

- `/api/agent-sessions` is off the PAT allowlist. It granted nothing — the middleware guarding it
  has no PAT branch — but its list route fans out across every project the caller can see,
  `messages[]` included, so the entry pre-approved that reach for whoever added a PAT branch
  later. A test now fails if any allowlisted prefix is unreachable by a PAT, which forces the
  grant to be made by someone looking at the route.

- Opening any issue now works again. Every issue's detail page answered "This page couldn't load" —
  not one issue, all of them, on every project — after the list endpoints started stating their own
  size in the response body. The comment thread was still read as a plain list, so the page threw
  before it drew anything. The Comments tab count also now comes from the server's own count, which
  stays right on an issue with more comments than one response carries.

- A pipeline reviewer on a machine with `MCP_TIMEOUT` set in its environment could write verdicts
  that were never posted, silently. The path the reviewer writes its verdict to was only handed to
  the session when Forge was also choosing the MCP timeout for it, so exporting that one unrelated
  variable removed the verdict path entirely — the same "written, never posted, no error anywhere"
  failure that the surrounding note already records from an earlier occurrence. The verdict path is
  now always passed.

- An integration whose shared credential was disabled can now be turned back on from the project's
  own settings. Two things gate an integration — the project's opt-in and the org-shared
  credential — and the API reported only whether both were on. Every provider card bound its
  Enabled switch to that single answer while its save could write the project's half alone, so with
  the credential disabled the switch reported success and snapped back, over and over, with nothing
  on screen saying which half was the problem. The switch now reads and writes the same half, and
  when the credential is the one that is off the card says so and offers to enable it, still gated
  on org owner or admin because that credential is shared by every project bound to it. Enabling it
  also refreshes the project views, which a credential change never used to reach. Found on
  forge-dev, whose Rocket.Chat bot had been unreachable from the UI since 2026-07-03.

- The instructions every agent is handed no longer describe steps its own project does not run.
  Three of them said `plan` and `acceptanceCriteria` are written by the clarify and plan steps —
  true on a staged project, and false on an autonomous one, which has neither step and one driver
  instead. One of the three was in the block injected into every job on every project. Four
  sessions had already stalled at that gap. All three now name the mode they mean, and a build
  check refuses a new one: a step named as the actor of something the reader is told about has to
  say which kind of project it belongs to, the same way a status transition already did.

- Listing chat and agent sessions no longer ships every word of every transcript. The web list
  selected the whole row, transcript column included, so a page of twenty conversations carried
  twenty full histories to render a title and a status — while the agent-facing list had projected
  around exactly that, and left a note saying why. Both now read one definition of a session row
  without its transcript, and the list reports the message count in its place. The same was true of
  schedules, whose prompt runs to twenty thousand characters a row.

- Creating a project no longer blames the slug for a collision it did not cause. Both the web and
  the agent path told you the slug was taken whenever the database refused the row for uniqueness —
  and three different things on that row are unique, so a caller could be sent off renaming a slug
  that was never the problem. The two paths were separate copies of the same insert; they are one
  now, and only a slug conflict reports a slug conflict.

- Reports of how busy a runner is now agree with the decision that actually places work on it.
  Four surfaces counted the jobs a runner is carrying, and none of them applied the rule the
  dispatcher has applied since a stall in May: a job whose pipeline run has already finished is not
  occupying anything. They counted it, so a runner could read as full to the project manager while
  the dispatcher considered it free — and work was routed away from a healthy machine on the
  strength of a job nobody was running.

- The project manager's two views of runner load no longer disagree. Its per-runner report and the
  digest it primes each decision turn with each ran their own copy of "how many jobs is this runner
  carrying", and the copies had already parted: one counted a queued job as occupying a runner and
  the other did not, so the same fleet read as busy through one door and idle through the other.
  There is one count now, and it no longer asks the database once per runner.

- Listing an organisation's members now returns the same record whether the caller is the web UI or
  an agent. The two had drifted: one of them reported each member's lenses and the other quietly
  left that field out, because each transport carried its own copy of the query. Both now read
  through one, and the health snapshot the two surfaces report was de-duplicated the same way.

- Every list the API returns now says how many rows exist in total and whether more are waiting,
  in the response itself. It used to say so only in a response header, which a route could forget to
  send and a browser could be configured not to read — and the client, finding nothing, counted the
  rows in front of it instead. A page of 50 out of 900 therefore reported "900 of 900", and anything
  deciding whether to fetch more simply stopped. Lists that cannot be paged through say that too,
  rather than leaving the caller to guess from the row count.

- An issue created with a blocker now records both, or neither. The blocking relation was written
  after the issue row had already been committed, so a failure in between — a rejected cycle, a
  dropped connection, a process restart — left the issue durable and its blocker missing. Nothing
  announced it, because the announcement had not run either; but the dispatcher does not only listen,
  it also polls, and the next sweep would pick that issue up as unblocked and run it ahead of the work
  that was meant to gate it. The relation is now written inside the same transaction as the issue, and
  the announcements that wake the pipeline still follow the commit, in the order they had before.

- A pipeline job no longer parks your uncommitted work. When a runner picks up a repository that
  already holds changes which are not the pipeline's, the workspace check leaves them alone and says
  so to the agent, instead of reporting the tree as broken and handing it to a repair step whose
  only remedy is to stash whatever is in the way. The two halves had been at odds: the check backs
  off from a person's edits on purpose, and the act of reporting that back-off is what summoned the
  step that cleared them.

- An autonomous turn that finished its work no longer gets recorded as a failure and run again from
  the start. Core already knew how to tell a lost report apart from a dead agent: when the runner
  misses the Claude CLI's terminal `result` event it reports the job failed, and `finalizeFailedJob`
  overrides that with `done` if the agent left a terminal step-handoff — a near-terminal write, so it
  is a signal from the turn itself rather than a side effect an agent killed mid-work would also
  leave behind. That rescue was unreachable for `drive`, the single turn that *is* the whole job on an
  autonomous project: the prompt only asks for a handoff on stages that have a payload schema, and
  `drive` had none, so it could never write the one signal the finalizer reads. The two halves were
  each correct and nothing joined them. Measured on ISS-874: two `[NO_RESULT_CLEAN_EXIT]` failures
  inside one hour, both after the issue had already moved to `needs_info` and a comment had already
  posted, each answered with a full re-run; six of the thirty-five most recent failed `drive` jobs
  carry that class of marker. `drive` now has a handoff schema and gets the termination protocol, so
  a completed turn is recorded as completed. A turn that died before writing its handoff still
  retries — that case is genuinely indistinguishable from one that finished, and re-running work is
  the safe side of it. (ISS-888)

- A retry that started from an empty transcript now says so, says which of seven reasons took the
  prior session away, and the rate is readable beside the failures it explains. Forge cannot promise
  a resume across a forced box change — a different-device failover exists because the account on
  the old box is exhausted — but a start-from-scratch and a continue were indistinguishable in the
  record, and 26 of this project's last 35 failed `drive` jobs took exactly that path. Every path
  that declines a resume now names itself in one vocabulary, on the attempt's own `agent_sessions`
  row; "no prior session to continue" stays uncounted, because attempt 1 is the normal shape of a
  first try and folding it in would make the number shrink as the project does more fresh work.
  A fourth path was found while enumerating the three the issue named, and it was worse than
  silence: the resume was decided BEFORE a runner was picked, and the selector falls through a
  stale pin to another box without telling anyone, so the unreachable session id was dispatched
  anyway and the attempt recorded itself as having continued a transcript it never saw. It is now
  settled after selection, as `pin_stale`. The count reads inside `forge_metrics.session_failures`
  — same project, same window, its own denominator — so the question that could not be answered
  from the outside ("did attempt 2 resume, or start cold?") is answered next to what killed
  attempt 1, rather than as a rate standing on its own saying nothing. (ISS-887)
- An autonomous issue no longer stops dead when its agent ends a session without finishing. The
  staged pipeline has two nets for "this issue is actionable and nothing is working on it", and the
  driver inherited neither: the reconciler's rescue selects on the trigger statuses of
  `PIPELINE_STEPS`, which do not include `in_progress`, and its in-flight reset filters on the job
  types of steps that have a working status — `code` and `fix` — while `drive` has no entry in that
  registry at all. So an agent that moved its own issue to `in_progress` and then stopped left it
  there under a live run with no job, and nothing in core could see it. Measured on ISS-880: the
  drive job finished at 13:12, the issue was closed by hand at 15:28, and the comment on it says
  the run was wedged so the pipeline could not close it itself. A new reconciler pass rolls that
  issue back to the entry status and lets the one existing dispatch path re-enter it — nothing here
  mints a job, so there is still only one way a drive job is born. The re-entered session continues
  rather than restarts: the drive prompt tells the agent to ask for its resume point first, and the
  run it belongs to is reused, so a branch and PR already pushed are still there. (ISS-890)

- The no-op loop cap now works on autonomous projects, where it had never once fired. It resolves a
  stage's job type through the staged registry, so on a project whose every job is a `drive` job it
  counted a type that does not exist and returned zero forever — the ISS-626 incident's own defence,
  absent on `forge-dev`, `getcontent` and `kinetrak` alike. Fixing it by counting `drive` instead
  would have replaced one defect with another: the staged count is bounded by "a done job of another
  type in between proves the issue advanced", and on a single-job-type pipeline nothing ever cuts
  that tail, so three legitimate human-answer cycles would have paused a healthy run. What is
  counted here is instead the rescues themselves, held on the run that owns them, and reset on the
  same kind of evidence — a rescue mints exactly one drive job, so a run whose done-drive count grew
  by more than one had work from somewhere else. When the allowance is spent the **issue** moves to
  `needs_info`, not just the run to `paused`: a paused run leaves the issue at its in-flight status,
  which the board still renders as running, and `needs_info` is the one park a human's answer
  restarts. **The trade-off:** a cap that has never fired is now live on three projects at once, and if
  its reset condition is wrong it pauses work that was progressing. What bounds the day-one exposure
  is that the allowance is stored per run under a key no existing run carries, and an absent key
  reads as a full allowance — so no run in flight today can be parked until this code has itself
  observed three rescues on it, and the worst first-day behaviour is three extra drive sessions on a
  run that is already wedged. (ISS-890)

- A UX Contract written from the Settings preset button reached no agent. Applying a preset compiled
  the rules into `projectFacts['ux-contract']` and stopped there: the flag that decides whether a
  fact is injected into every agent prompt or merely fetchable on demand was read by that code path
  and never written, so an absent key left the contract dark while `forge-code` and `forge-clarify`
  both tell the agent it arrives "injected in your preamble". The QA project is the measure — 22
  active rules compiled to 2,925 characters on 2026-08-11, and zero findings in the nineteen days
  since; the two projects where the loop did work had the flag set by hand. A recompile now turns
  injection on when nobody has decided, and leaves an explicit off alone, because that is a person's
  decision rather than a default. Ten frontend repos that had no contract at all now carry a
  hand-written one. (ISS-576)

- `core`'s lint could report a failure while naming only files that were clean. Biome prints twenty
  diagnostics by default and orders them by path rather than by severity, so on a tree with several
  hundred standing warnings a single new error could fall outside the window: a planted error in one
  source file produced a two-error summary with no mention of that file anywhere in the output, and
  every visible diagnostic pointed at an untouched test. The lint budget checker in this same repo
  had already defended against exactly that by raising the cap; the package script now agrees with
  it, and prints every diagnostic it counts.

- The UX Contract settings tab no longer offers a Re-scan control. Nothing has ever detected a
  project's stack — the values shown come from the profile that applying a preset writes — and the
  button had been disabled since it was added, with a tooltip naming the issue that was going to
  make it work. That issue and its four children are dropped, so the control was promising work
  nobody is doing. The panel now reads as what it is: a read-back of the recorded profile.

- `pnpm test` could report green over tests it never ran. `scripts/**/*.test.mjs` — which covers the
  gate scripts, where this repo's rules live — is collected only by `packages/core`'s test config,
  but `scripts/` sits outside that package, so a change to a checker did not invalidate the cached
  result and turbo replayed an older run's log instead. Measured on one touched tree: a cache hit
  before the fix, a cache miss after it. CI was never affected, since its path filter already runs
  the core job on `scripts/` changes; the hole was in the local command contributors are told to
  trust. (ISS-848)

- On an autonomous project, splitting an issue into children now works end to end, and a park
  always has a way out. Two paths could put an issue on a status no dispatcher reads and no
  person could wake, which is the state-never-lies principle breached in the one place nothing
  else watches. Decompose promoted its children to `approved`, a status the autonomous
  dispatcher never looks at — it reads `open` and nothing else — so the children sat untouched
  while the board rendered them as *running*; ten issues across two projects were frozen this
  way when the fix landed, one of them for eleven days. Separately, an agent asking a human a
  question could land the issue on `waiting`, which the comment-answer path deliberately never
  restarts, so the question could never be answered. Now the cascade targets whichever status
  that project's driver actually dispatches, a parent moved to `approved` by a human following
  an older guide is carried on rather than left there, the parent's own work is held until every
  child's code has merged, and an agent's `waiting` is rewritten at write time to the one park a
  comment does restart — after the guards run, so the reason it must give and the kind it must
  declare are still demanded and still posted. A person's own `waiting` is left alone, because
  their pause is theirs to end, and the parks already sitting there are now surfaced to a human
  instead of waiting unannounced. Staged projects are unchanged, deliberately: one project's
  driver must never change another's vocabulary. (ISS-886)

- The record of what shipped can no longer be lost quietly, and an issue can no longer be marked
  shipped with nothing written about it. Two separate holes, found together. The changelog was
  owned by no check at all: 1,034 lines of it were deleted inside a commit about documentation
  pointers, twelve gates ran on that change and every one passed, and because the in-app What's New
  feed reads the file and shows an empty list when it cannot parse one, it went blank for everybody
  signed in without anything failing. A new check now holds the file — the heading its five readers
  need has to stay, and an entry published there cannot disappear unless the change says which entry
  and why, in a ledger that shows up in the diff. Entries are matched by their words rather than
  their position, so re-wrapping a line or cutting a release moves them all without complaint.
  Separately, an automated close that would mark an issue as shipped is now refused while nothing
  has been written about what shipped: four issues closed that way in one day in August, their
  release notes never written and the omission found by a sweep days later. The batch release is
  stopped earlier, when it claims the issues rather than when it closes them, so it never gets far
  enough to make the claim. Writing "no user-facing change" is a complete answer and always was —
  what is refused is saying nothing. Closing an issue by hand is untouched, and so is discarding
  one as not-work. What the refusal holds is that something is written on the issue before it
  closes; whether that line then reaches this file is the first half's job, not its own.
  (ISS-880)

- A pipeline run under an issue that was DROPPED is now closed, and its queued steps with
  it. The backstop that closes runs whose issue has already finished matched only `closed`,
  while the set of statuses that close a run has been `{closed, dropped}` — so an issue
  abandoned rather than completed left its run open forever with its queued steps orphaned
  underneath, and nothing on any axis reaped them. `dropped` is one of the five statuses the
  autonomous driver may write, so this was reachable on every autonomous project. (ISS-879)

- Cancelling a pipeline run from the run view now announces itself. Cancel flipped the run
  and told the browser, but never emitted the lifecycle event three other things listen for,
  so an operator cancel silently skipped them: release-batch claims were left for a
  once-a-minute sweeper to find, the new frozen-queue notification was never cleared, and
  memory candidates were never mined from a cancelled issue run at all. (ISS-879)

- Clearing a notification is now a single locked statement instead of a read followed by a
  write. With one clearer per notification that pair was safe; the frozen-queue notification
  above is the first with two, and both could see the same row unread before either wrote,
  decrementing the reader's unread count twice for one notification. (ISS-879)

- `noProgressRounds` now reaches the mode the pipeline actually runs in. The knob had two readers and
  only one worked: the prompt printed it to every agent, while the alarm compared it to an issue's
  total reopen count — a number that moves only on a `reopen` transition, which autonomous mode never
  performs, because the driver holds the issue in progress from claim to close and the review loop is
  a phase re-entry. Measured 2026-08-30: of 19 runs that went five or more coding rounds inside ONE
  autonomous run, 18 had a reopen count of zero, and the one exception was alarming on reopens from
  its earlier staged life, days before the churn nobody was told about. A second pass counts the
  thing that does move — consecutive review rejections in one running run, with no approval in
  between — and notifies when it reaches the same number. It counts rejections the reviewer wrote,
  not the agent's own account of its progress, so an agent cannot decide whether it is churning; the
  agent's `churn` ledger stays as the human's reading material and is named as such. Rounds that each
  fix a different blocker still do not alarm, and one approval resets the count. Nothing is capped,
  parked or blocked — there is still no limit on how many rounds an issue may take. (ISS-878)

### Changed

- **A device token no longer reaches the API as its owner.** `requireAnyAuth` — the middleware
  behind attachment uploads and two comment routes — used to accept a runner's device token and set
  `userId = device.ownerId`, which was the single place in Forge where a credential silently became
  a person. It is deleted, along with the probe that existed to measure it. A caller presenting a
  device token there now gets a 401 rather than its owner's account, and the caller class it served
  holds a real scoped token instead: `job:<id>` from the moment a job is claimed, `session:<id>`
  from `agent:start`. Four middlewares still verify a device token on the runner's own control
  plane, and none of them grants ambient owner authority. (ISS-927)

- **The audit trail records who was at the keyboard, not just whose account it was.**
  `kernel_transitions` gains `actor_agency`, finishing the axis `activity_log` started: `actor_type`
  answers who owns a write — truthfully the person a job or session token was minted under — while
  `actor_agency` answers whether a machine made it. The field is required on a `user` actor and
  refused on the others, so `system`, `sweeper` and `runner` cannot be recorded as people and no
  call site can quietly inherit the column's default. The activity feed reads it per row, ORed over
  the existing actor-type test so that every row written before the column existed keeps exactly the
  marker it has today. (ISS-927)

- **The docs stop offering the runner's own passthrough as the surface a skill calls.** Two
  command-line tools reach core's data plane — `forge-runner api`, built in this repo, and `forge`,
  the 21-verb CLI built in `forge-plugin` — and until now nothing said which belonged to whom.
  `docs/architecture/data-plane-surface.md` opened by presenting its table as *"what an agent or a
  skill author calls instead"*, drew *"agent in a job"* as the caller, and addressed its whole
  calling section to *"the agent process"*. A skill author reading it came away with the wrong verb.

  The page now says what it is: documentation of `forge-runner api`, the Rust daemon's own reach
  into core, with exactly two callers named — the daemon's subcommands, and the drive-job shell
  that core's own prompt hands `$FORGE_PAT` to. A skill is neither, and the page says so and links
  to `agent-surface.md`. The MCP↔REST twin table is untouched: it maps the data plane and is true
  whoever calls the route. Both index rows (`docs/README.md`, `docs/architecture/README.md`) are
  rewritten in the same change so no index still routes an agent here.

  `forge-runner api` is not deprecated by any of this and does not move. A daemon that could not
  reach core until a Claude Code plugin was installed would be a worse daemon.

- **The frozen MCP surface cites a document, not only a tracker number.** `registered-tools.ts`
  named `ISS-894` as the authority for shrinking the tool list, and seven commits cite it. That row
  exists and is the right one, but it sits at `draft`, which no list or pool view of the project
  shows — so a reader who went looking concluded the authority was missing. The guard now carries a
  `cm:edge naming` to `docs/architecture/agent-surface.md`, which holds the deletion rule in prose
  and can always be opened, alongside the number. `agent-surface.md` names `ISS-894` in its delivery
  table for the same reason, and records that the per-tool device count the deletion rule turns on
  is readable only with direct database access — there is no aggregate route over `mcp_audit_log`,
  so no agent session can satisfy that rule, and none may delete on an estimate.

- **The master, and the way it takes work, stop being one-shot.** The per-project master agent was
  a `claude -p` child of the runner daemon: killed and restarted every 30-second pass, unreachable
  by a human, inventing its own session id so core had no record it existed, and writing its
  reasoning to a `last-pass.log` that the next pass truncated. Measured 2026-09-05 on forge-vm — the
  master's account of why it claimed ISS-917 was gone three minutes later.

  It is now a **resident tmux session** named `forge-master-<slug>`, parented by the multiplexer
  rather than by the daemon. An operator can `tmux attach -t forge-master-forge-dev` and watch it
  work, or `forge-runner master say <slug> "<text>"` and type at it; core can address the same pane
  through the existing `session_inbox` with its `delivered`/`gone` ack. It survives a
  `forge-runner` restart, its transcript appends instead of truncating
  (`forge-runner master log <slug>`), and every pass after the first starts from context it already
  has.

  Taking a job and starting it are now two acts (`pool prepare` / `pool start` / `pool discard`;
  `pool claim` is the first two composed). A master can hold a preparation, look at it and hand it
  back — the single irreversible verb it replaced made that impossible. The job stays `queued` and
  held in between, so every release path that already existed covers the gap, and the daemon returns
  a preparation nobody started after two minutes.

  Two protections had to be rebuilt because the daemon is no longer the parent. A dead master used
  to be detected by its control socket dropping; it is now detected by its tmux session no longer
  existing, checked every sweep, which returns its holds in ≤30s instead of core's three-minute
  reaper. And `SESSION_IDLE_TIMEOUT`, which killed a master for sitting still, is replaced by a
  ceiling on silence *after a prompt* — a resident master between passes is idle on purpose and is
  no longer reaped for it.

  The agents the master starts are deliberately NOT pane-hosted, and the price is stated rather than
  skipped: a pane costs the structured stdout `job_events` is parsed from, and `job_events` is the
  only way anyone sees a subagent that is alive and not progressing. They get the addressable half
  instead. Recorded as decision ⑥ in `docs/proposals/master-orchestration.html`, with §5 case ③,
  §6 and §10's first open question corrected in the same commit.

  Ships as `runner-v0.12.0`; a box without `tmux` starts no master and says so (`forge-runner
  doctor` checks for it). A runner below the split answers `runner_too_old` at
  `POST /api/devices/me/pool/claim`, which is a named refusal an operator can act on rather than a
  second live path.

- **`pnpm verify` runs its checks in parallel, and `tsc` stops recompiling the world.** 66s to
  28.4s, with no check narrowed and none removed. Two causes, both measured 2026-09-06 on 12 cores:
  the runner was a plain `for` loop over 20 independent child processes, and `packages/core`'s
  typecheck config had no `incremental`, so every run was a cold compile of 2,711 files (22.5s cold,
  3.1s warm). Concurrency is bounded at 6 and tunable with `VERIFY_CONCURRENCY` — serial 41.9s,
  width 4 32.6s, width 6 28.4s, width 12 28.4s, flat past 6 because `tsc` is itself multi-core.
  Results stay in `CHECKS` order however the processes land, because the report and the ci-parity
  proof both read that array by index. The build-info file sits under `node_modules/.cache/`, which
  is already ignored.

  What was NOT done, and why: scoping the checks to the diff. The guard on `codemap prose` records
  what that costs — a scoped run on a push straight to `main` has an empty diff, cm prints its
  success line over zero files, and 15 CM001 errors reached `main` that way. `archmap` and the
  referential tier have the same shape: a graph built from one file makes an illegal edge legal, and
  a dangling `cm:edge` is attributed to the annotated file and dropped when that file is outside the
  diff. The time was in running things twice and running them one at a time, not in what they read.


- The autonomous driver's preamble tells it to recall, when to capture, and where a defect goes
  (ISS-790). Three of that issue's five wanted behaviours were agent behaviours with nothing behind
  them: `memory-recall-first` targets `clarify`/`plan`/`fix`, three staged rungs the driver lane
  drops by design, so on an autonomous project nothing had ever instructed a driver to recall at all.
  The lane now carries a recall block that fires **every time the work turns to a new area** rather
  than once at the start, with the `memory/feedback` verify-report half that keeps recall
  self-cleaning; `## Capture Learnings` states the moment ("not at the end of the run"); and a new
  rule sends a live defect to the code or the tracker, never into memory as a note — one such note
  sat unfixed for eight days with no issue for it.

  Extra fix: the same preamble handed the driver `issues/<id> -X PATCH -d '{"status":"in_progress"}'`,
  which 400s — `issuePatchSchema` is `.strict()` and carries no `status`; every post-creation status
  change goes through `issues/<id>/transition`. Measured live against the API, and
  `drive-prompt-lane.test.ts` had been asserting the broken shape, so the gate held the defect in
  place.

- **The master names the agent it starts, and that name is the branch and worktree the work lands
  in.** Core used to derive it: `worktreeBranchPayload` sent `ISS-<seq>` as the job's
  `worktreeBranch`, so every job got a checkout named after its issue and a master could not put two
  issues in one place. That rule, its `0.9.3` runner floor and its merge-stage exemption —
  unreachable since ISS-897 left `drive` the only dispatched type — are deleted rather than left
  beside the new path. `forge-runner pool claim` now takes a required `--agent <name>`: the daemon
  refuses a claim with no name (`agent_required`) or an unusable one (`agent_unusable`) **before**
  claiming, so there is no hold to give back and no job quietly writing the repo root. Reusing one
  name across several claims puts those jobs in one checkout on one branch — the grouping the master
  decides, which nothing checks for it: two issues on one branch ship as one diff.

- **Salvage finds a failed job's work by the branch the master named, exactly.** It matched the issue
  key against branch prefixes, which could not see a grouped agent's branch at all and, when a prefix
  hit two trees, broke the tie by modification time — how a stranger's branch got committed to. The
  prefix match, the mtime tie-break and the "several dirty and no issue key" refusal are gone; more
  than one tree claiming the branch is now a refusal that names the fault instead of a guess that
  looks like it worked. Salvage is also offered to every claimed job now, not only one serving an
  issue, because every job has a worktree of its own.

- **A claim from a runner older than 0.11.0 is now refused by name.** Deleting `worktreeBranch` left
  a version skew that fails silently in the worst direction: an older runner resolves no branch,
  takes the `owns_root` path, and runs the agent **in the repo root on the project's base branch** —
  committing unreviewed work onto `main` while the job reports success. Found live on dev1 the same
  day, with core deployed against binaries still on 0.10.5. The claim now reads the box's reported
  version and answers `{ ok: false, reason: 'runner_too_old' }` — an ordinary refusal on a 200, like
  `already_held`, checked before the hold so there is nothing to give back and the job stays
  claimable for a box that can take it. Not an error: a throw would reach the master as a bare 500
  with the reason nowhere, and an operator whose box has gone quiet reads that reason in the
  master's own transcript. The check sits on the claim rather than the pool listing for the same
  reason — hiding the work would leave an old box idle with nothing anywhere saying why.

- **A runner's status is now a real drain switch, and until this it was a silent no-op.** Moving a
  project from one box to another needs "stop taking new work, finish what you have", and nothing
  provided it: `GET /me/runners` returned `status`, `MeRunner` parsed it, and no code on either side
  read it — so `forge_runners retire`, and every status change, left the box claiming exactly as
  before. A master now skips a project whose runner on this box is `draining` or `disabled`, logging
  which, and jobs already running are untouched because nothing kills them. `offline` deliberately
  still takes work: the heartbeat writes it and it lags a live box, so gating on `online` would have
  a box refuse its own work over a stale row.

- **The worktree reaper now sweeps `.worktrees/` as well as `.claude/worktrees/`.** It walked only
  the second. That was survivable while core derived every branch from the issue key — an issue
  reused one checkout however many stages it ran, so the naming was the ceiling on how many could
  exist. A master that invents a name per pass removes the ceiling, so the same predicate (older
  than 14 days · nothing unpushed · no modified tracked file) now runs over both roots. Unreaped
  trees are a liveness problem, not tidiness: ubuntu6 reached 100% disk on 2026-08-20 with 64 stale
  worktrees holding 29G.

- **Removed: `issueBranchName` and the snapshot's `featureBranch`.** Both existed to tell the runner
  which branch an issue's work belonged on, and after `worktreeBranch` was deleted nothing read
  either — the agent stands in its branch's checkout and needs no one to name it.

- **A master pass is no longer killed at 150 seconds.** Measured on dev1 2026-09-05: passes weighing
  one or two jobs took 30–88s and finished, and three consecutive passes weighing three or four hit
  the ceiling and were killed mid-decision — the time-box was selecting against exactly the passes
  with the most to weigh, in a design whose whole value is the master's judgement. The bound is now
  ten minutes and is a hang-breaker, not a time-box.

- **A master now belongs to a project, not to a box, and stands in that project's checkout.** The
  daemon asked core for one box-wide pool and started a single master for all of it, in a directory
  of its own. It now asks `/me/runners` which projects this device serves — core, not `config.toml`,
  because the two disagree in practice — reads each project's pool separately, and starts at most one
  master per project, in that project's own checkout on its base branch, told which project it is and
  which branch its agents cut from. Projects no longer queue behind each other. The `forge-master`
  skill drops two claims that stopped being true: that a master starts subagents itself (the daemon
  starts the job as part of the claim) and that a dying master parks the jobs it holds (since
  `fd1265751` a claim ends its own hold, so a master that stops parks nothing). A box-level ceiling on
  total claude processes is still owed — `duplex_max_sessions` bounds duplex pipeline jobs alone, and
  a master takes no permit.

- **A box now takes its own work; nothing pushes it.** Core keeps jobs `queued` and offers them at
  `GET /api/devices/me/pool`; the runner daemon polls that every 30 seconds and, whenever anything is
  claimable, spawns one master — a Claude session running the `forge-master` skill — which decides
  order and batch size and claims. The `job.assigned` frame, the dispatch tick, the per-project
  concurrency cap and the five dispatch gates are gone; the only condition core still enforces at
  claim time is one in-flight job per issue. A claim goes through the daemon's local control socket
  rather than straight to core, because taking a job and running it must happen in the one process
  that holds the repo lock and the in-flight map — `forge-runner pool claim` now refuses when no
  daemon is listening, which is the honest answer, since nothing else on that box could run the job.
  A master is killed at 150 seconds so it can never outlive the 3-minute hold core gives it.

  A claim stamps the job onto the box — `status='dispatched'`, `device_id`, `runner_id`,
  `dispatched_at` — the same four columns the old `claimRunnerSlot` wrote. The runner's own routes
  are gated on them (`lifecycle`, `events` and `turn-verdict` each 403 unless `jobs.device_id`
  matches the calling device, and ack additionally requires a non-queued status), so the first
  cut of this shipped without them and produced exactly that: measured live on 2026-09-05, two jobs
  started on the correct repos and every ack and event came back 403. Every path that drops a hold —
  release, the socket-drop path, the 3-minute reaper — unwinds those columns again, but only while
  `acked_at IS NULL`: an acked job has a detached agent behind it that outlives its master, and
  re-queueing that would offer a second box work already running.

  The 3-minute reaper now sees a master that has no session row. It joined `agent_sessions` on
  `held_by`, but a master is a bare Claude process that invents its own session id and writes no
  such row, so the join matched nothing and the sweep reaped nothing — measured live on
  2026-09-05, a job sat held by a master forty minutes dead, offered to no pool and swept by
  nothing, which is the silent wedge `VISION: state-never-lies` calls a kernel bug. A holder with
  no row is judged by `held_at` age instead, since there is no heartbeat to read; the two arms that
  DO have a session keep reaping on its status and heartbeat immediately.

  Every process the runner spawns now leads its own process group. `graceful_kill` signals `-pid`,
  which reaches nothing unless the child is a group leader — the agent lane called `setsid` itself
  and so was fine, but the master and the setup agent were not, and both had timeouts that logged a
  kill they never performed. Measured live on 2026-09-05: a master the daemon reported killing at
  150s was still running eleven minutes later. Setting it in `build_command` covers all three lanes.

  The `forge-master` skill ships **inside the runner binary** and is written to the master's own
  directory before every pass. Nothing else could deliver it — project skill sync writes into a
  project's checkout and the master runs in no checkout — and a master told to use a skill that is
  not on disk loads nothing and improvises the orchestration silently. The price, stated: editing
  the master's process now needs a runner release, where a project skill needs only a push.

- **`job_events` stops storing the CLI's partial-message frames.** `POST /jobs/:id/events` no
  longer persists a `stdout` row whose `line.type` is `stream_event`. Measured on forge-beta
  2026-09-04: the table held 7.29M `stdout` rows — 99.79% of it — and 74.8% of those were
  `stream_event`, frames `lib/agent-stream-parser.ts` answers `{messages:[]}` for and no other
  reader in core or web opens. They were stored forever and re-read on every incremental
  transcript derive, which re-parses the job's whole event history each time it fires.

  The filter is a denylist of that one proven-unread type, never an allowlist: a frame kind the
  CLI adds next release keeps being stored, because an allowlist would drop it in silence. It
  applies to persistence ONLY — the ack stamp, the session heartbeat, `runtime_state` and the
  derive cadence are all still computed from the unfiltered batch, so a fan-out session that emits
  nothing but deltas for minutes still reads as alive. That separation is the whole reason
  `--include-partial-messages` is on (ISS-479) and it is asserted directly.

- The default PAT rate limit is 600 requests a minute, up from 60. 600 is the number job tokens
  already pinned, six times the measured peak of one busy session. `RATE_LIMIT_PAT_MAX` still
  overrides it. The first rejected request of each window now writes a `rate_limited` row to
  `mcp_audit_log` (tool `rate_limit`, action `<METHOD> <path>`), so a throttled token is visible
  without reading server logs.

- **Project Settings matches how Forge runs: one autonomous lane, and a release step the project
  declares.** The Pipeline tab showed a nine-rung ladder (`confirmed` → `clarified` → `approved` →
  `developed` → `testing` → `tested`), eight `autoX` step toggles, merge points, session groups and
  a per-stage skill picker — configuration for a lane that `43b71a4c` had already made unreachable.
  A screen that offers a control nothing reads is worse than one that offers none: ISS-892 was about
  to redesign it, and would have redrawn the dead boxes faithfully.

  What is gone from `pipelineConfigSchema`, and therefore from every stored project on its next
  save: the eight `autoX` toggles, `sessionGroups`, `onResumeFail`, `mergeStates`, `mode`, and
  per-stage `skipComplexities` / `sessionGroup`. `STAGE_NAMES` is now exactly the four statuses this
  lane reaches — `open`, `in_progress`, `needs_info`, `released`. Removing the toggles from the Zod
  object is what deletes the staged orchestrator, not merely its screen: `loadPipelineConfig` parses
  through that schema and it strips unknown keys, so `isToggleEnabled` answers false for every stage on
  every project and `considerEnqueue` can no longer enqueue a staged job at all. The staged dispatch
  path is deleted rather than left unreachable.

  **The release gate is now derived from the project, not configured.** It used to be
  `states.tested.mode === 'manual'` — a project answered "do I ship to production?" by configuring a
  stage it never ran, and the gate returned the literal `'tested'`. A project has production when an
  active `prod` binding exists AND `productionBranch <> baseBranch`; the gate is then `released`, and
  otherwise there is none and the driver's `closed` means what it says. Trunk-based projects with an
  observability or storefront binding (forge-dev carries two) correctly get no gate.

  Two refusals replace two silent fallbacks. A gated project whose production binding names no
  `releaseRunnerLabel` fails its release run with `RELEASE_RUNNER_UNDECLARED` instead of picking a
  box off the fleet — a release procedure that runs on an arbitrary machine is how a deploy reaches
  the wrong environment. And a failing release on a project that declared no `rollback` aborts with
  one comment per issue and leaves them at `released`, rather than rolling back blindly: from inside
  one session an outage that predates the release is indistinguishable from one it caused.

  Settings now names the missing half of the contract — `build-commands`, `test-commands`, and
  `release-procedure` where there is production — before the first issue runs rather than when a job
  discovers it. `agentConfig.plugins` became editable in the same tab (marketplace, name, pinned
  SHA, autoUpdate, whole-list replace); it had been read by `GET /api/devices/me/plugins` since it
  shipped and written by nothing with a UI.

  Migration `0195` moves the data with the schema. Every issue at `tested` becomes `released` — 66
  across 10 projects measured 2026-09-03, each at a real gate — with `merged_at` untouched, because
  none of them has been released and that column is what unblocks their dependents. The staged keys
  are stripped from `agentConfig.pipelineConfig` on 34 projects. Left deliberately in place: 8
  issues at `testing` / `developed` / `approved` / `confirmed` / `clarified`, mid-flight under the
  removed lane in projects this change does not own. Nothing dispatches them afterwards, and both
  automatic dispositions are worse than saying so — `open` would fire 8 unrequested drive jobs
  across other people's projects, `needs_info` would park them with no reason. Their owners decide.

  The `release` skill itself lives in `SidCorp-co/forge-plugin`, so no diff here can carry it; its
  contract — input, output, and the three questions nobody has answered — is written down in
  `docs/proposals/release-step-contract.md`. (ISS-897)
- **A chat round's tool calls run concurrently.** `runTurnEvents` executed the calls a model made
  in one round serially, against an eight-round cap that the serial time made expensive. Calls are
  now grouped by tool name — different tools run under `Promise.all`, same-name calls stay
  sequential in model order, because `guardIssueWritesDeduped` is a SELECT-then-INSERT with no
  uniqueness constraint behind it and two concurrent `forge_issues create` would both pass the
  duplicate check. Results are fed back in model order so every `tool_call_id` gets exactly one
  reply, and a throwing tool becomes an `isError` result rather than aborting the round.
  `parallel_tool_calls` is not sent: an unknown parameter through the proxy onto Vertex is a 400.

- **The per-turn context left the system prompt.** The Rocket.Chat conversation seed and the web
  `pageContext` were rendered into the system message, so the `system + tools[]` prefix that
  prompt caching keys on changed every turn. `chat/turn-context.ts` now prefixes them onto the
  newest user message on the provider copy only (never persisted); `buildSystemPrompt` no longer
  takes either. Not a second system message — LiteLLM hoists every system role into Gemini's
  `system_instruction`, which puts the volatile block back in the prefix — and not its own user
  message, which breaks Gemini's role alternation. `progressFacts` stays in the system prompt: it is
  the ISS-671 kernel fact that must survive `systemPromptOverride`, and it changes only when the
  counts do. `POST /api/chat` now sends the same 30-message window the Rocket.Chat path always did.

- **One chat adapter, and it speaks OpenAI.** `chat/providers/litellm.ts` is now
  `chat/providers/openai.ts` and registers as `openai`: the wire format is the contract
  (`providers/types.ts` mirrors Chat Completions exactly), so a LiteLLM proxy, a vendor endpoint or
  anything else OpenAI-shaped is a URL, not a new adapter. `'litellm'` stays registered as an alias
  of the same factory — `app_config.chat_provider_id` holds it for projects pinned before the
  rename, and `resolveForProject` drops the row's `chat_model` along with an id it cannot resolve,
  so removing the alias would silently re-pin those projects to the env default model. `LITELLM_*`
  keeps its name because it names the deployment's proxy rather than a vendor, so no
  operator has to rename anything. `'gemini'` is aliased to the same factory for the same reason —
  see Removed. `.forge/codemap-baseline.json` and `.forge/size-baseline.json` were re-keyed by hand
  to follow the rename: identical frozen comment hashes, the identical 184-line function allowance,
  moved from the old path to the new one. No `--update-baseline` was run and nothing is newly
  forgiven — the baseline diff is the rename and nothing else.

- **The Rocket.Chat reply paths share their plumbing, and the mention hot path stops paying for a
  finished investigation.** The `TEMP DIAGNOSTIC` added in `45aa40fe` fired three
  `Sentry.captureMessage` calls on every bot mention — up to `2C + 2` info-level events per user
  message for `C` active connections, on the same quota as the `captureException` calls that report
  real failures. Its own exit condition ("remove once the root cause is pinned") was met the same
  day by `56a66671`, which found the manager-global dedup tracker and made it per-connection. It
  outlived its purpose by seven weeks because "TEMP DIAGNOSTIC" is not marker-shaped, so no gate
  aged it out; the rule it recorded is now a `cm:guard` on the route-before-dedup ordering, which
  is the thing a future editor must not break.

  The two completion bridges duplicated their marker plumbing verbatim — field-identical metadata
  interfaces, two readers differing only in a JSON key, two copies of the compare-and-set
  `deliveredAt` claim — and `agent-chat-bridge.ts` imported `extractFinalAssistantText` from its
  peer bridge, which is what a shared helper with no home looks like. All four now live in
  `room-delivery.ts`, parameterized by the marker, whose header already declared itself the place
  where the bridges are kept in lockstep. `extractFinalAssistantText` calls
  `messageRoleToTurnRole`, the normalizer its own docstring had cited while hand-rolling the
  discriminator beside it.

  `handle` no longer smuggles three values out of a nested closure. The `''`-means-skip-the-send
  sentinel and the mutable `sendProof` are one `TurnOutcome` union, so the screening verdict
  travels with the text it proves rather than in a variable a later branch could leave stale —
  the same property `outbound.ts` already enforced at the type level for `sendFixedReply`, now
  true of the decision that calls it. `buildRoutes` ran two queries per binding inside its loop,
  so a 10-binding connection paid 21 round-trips on every reload, and reload fires on any
  connection or binding write; it is three batched queries, with the newest-binding-wins ordering
  it silently depended on now stated as a guard on the query that provides it.

- **366 comment lines left `integrations/rocketchat/` and `chat/`, and the prose that mattered
  stayed.** Roughly thirty multi-line JSDoc blocks became single-line `cm:guard`s — better
  placement, not just fewer lines: a `cm:guard` is injected into an editing agent's context where
  JSDoc prose has no consumer. Nine files in `integrations/rocketchat/` went from 607 comment
  lines to 241. Every `cm:ignore` / `i18n-allow` directive was kept, and dated incident evidence
  survives compressed; what is gone is narrative, and `git show` on this change's parent is where
  the long form lives. The ESLint `comment-density` rule that drove the pass was NOT adopted —
  comment content is codemap's axis (`CLAUDE.md`), and the rule's plugin resolved through a
  `link:` path outside this repository, so neither CI nor a contributor could run it. The trim
  stands on its own; the gate does not exist.

- **`pipelineConfig.mode` defaults to `autonomous`.** It was optional, and absent read as `staged`,
  so every project created since the mode existed started on the staged pipeline whether or not
  anyone wanted it. Measured 2026-09-02 across 31 live projects: 28 said `autonomous` explicitly,
  **0 said `staged`**, and the 3 that said nothing had 12 jobs between them with none since
  2026-08-11. Staged was not a choice anyone made; it was the answer nobody gave.

  The default lives in `resolveMode`, which has three readers — `isAutonomous`, the skill lock, and
  the reconciler, which reads the raw SQL column rather than the parsed config. A project that
  dispatched under one driver while its bundled skills locked under the other is what a second copy
  of `=== 'autonomous'` would buy. `isAutonomous(null)` still answers staged, and that is now stated
  rather than implied: a config that did not parse is a different case from a project that never
  chose, and answering `autonomous` for an unreadable one would rewrite parks and cascade children
  on a project nobody can see is broken.

  **What this costs, named rather than discovered later.** `assertAutonomousReady` refuses the write
  that sets `mode: 'autonomous'` while `build-commands` or `test-commands` is unanswered. A project
  carrying the default made no such write, so it reaches the driver having answered no contract —
  and `forge-drive/SKILL.md` said outright that "a project cannot be switched to autonomous mode
  without them". That sentence is now false for the default path and has been replaced with the
  weaker truth: read the facts, and if they are missing, say so in the close comment and name what
  you ran instead, rather than reporting a phase green on a command nobody declared.

  Three projects carried the default. `forge-plugin` was pinned to `staged` explicitly so the flip
  changes nothing for it. `qa-iss319-create-verify` and `qa-project-available-for-testing` could not
  be pinned — the credential doing this work is not admin on either — so both flip to autonomous
  with no contract facts. Neither has run a job since 2026-08-11 and both are QA projects, but that
  is a consequence someone chose to accept, not one that went unnoticed.

  **Nine test suites spelled "staged" by omission and now say it.** That is the same defect as the
  fleet's, in fixture form: `agentConfig: null`, a mock row without the column, a helper that seeded
  no config at all. One of them — `answer-resume-e2e` — asserted the old default in its own title
  ("treats a project that declared no mode as staged") and is kept, inverted, because it is the only
  place the default is observable end to end. `createTestProject` deliberately still seeds NO mode,
  so a fixture resolves whatever the product resolves and the next flip surfaces in the suites
  instead of hiding behind a helper that pinned the old answer.

- All five middlewares that authenticate a bearer token now read it through one pair of
  functions instead of five copies of the same regex. No route changed what it accepts. The two
  differences that were real are kept and named: whether the `forge_auth` cookie may stand in for
  a missing header, and whether "no header" and "malformed header" get the same 401 — `/mcp`
  answers those differently, and collapsing them would have downgraded its challenge.
- Corrected the record of how device tokens are authorised. It said three middlewares disagreed;
  there are five, and four of them already agree — a device is its own principal, with no access
  to its owner's account. `requireAnyAuth` is the single exception, and it is now instrumented:
  when a device token reaches it, core reports `auth.device_token_on_data_plane` with the route
  it hit, so the branch can be removed on evidence rather than on a source read that found no
  caller.

- The three gates that freeze a per-file number — test-signal, the lint budget and the size budget —
  now run one shared ratchet instead of three copies of it. Each carried its own registry read,
  baseline I/O, freeze comparison and staged-file collection, and the copies had drifted apart:
  `check-size-budget`'s own comment named `check-lint-budget` as the version it must not drift from
  with nothing enforcing that, while `check-test-signal` fell back to built-in defaults when the
  registry was missing, read a failed `git diff --cached` as an empty stage — a commit hook
  reporting clean because git broke — and overwrote a baseline it could not parse. All three now
  fail closed the same way, and each keeps its own entry point, its own baseline file and its own
  conformance axis. Detection policy is unchanged: old and new were run against each other over the
  frozen records, both ratio rules seeded separately, the assertion-count boundary either side, a
  regression on a frozen file, the staged path and the re-freeze, with identical output and exit
  codes throughout. (ISS-848)

- The test-signal baseline had drifted since it was frozen and is re-cut at the measured numbers:
  one file had left the low-signal ratio entirely while two others sat under ceilings up to 32
  above their real counts. Every ceiling moved down and a dead record left. (ISS-848)
