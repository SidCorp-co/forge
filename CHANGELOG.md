# Changelog

> **Cutoff: 2026-08-28.** Nothing before that date is carried here. 1,034 lines were removed in
> `3df9a8e9`; the owner decided on 2026-08-31 not to restore them, and that decision stands rather
> than being revisited each time someone notices the gap. They are readable at
> `git show 3df9a8e9^:CHANGELOG.md`. Later cuts trim the same way: git is the record of what
> shipped, and this file is the short reader-facing view of the recent end of it.

## [Unreleased]

### Added

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
  landed-then-`reopen` stay distinguishable. Nothing calls these yet: the push path still runs and
  is deleted in one step once a master runs against them
  (`docs/proposals/master-orchestration.html`).

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
