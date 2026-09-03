# Changelog

> **Cutoff: 2026-08-28.** Nothing before that date is carried here. 1,034 lines were removed in
> `3df9a8e9`; the owner decided on 2026-08-31 not to restore them, and that decision stands rather
> than being revisited each time someone notices the gap. They are readable at
> `git show 3df9a8e9^:CHANGELOG.md`. Later cuts trim the same way: git is the record of what
> shipped, and this file is the short reader-facing view of the recent end of it.

## [Unreleased]

### Added

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

### Fixed

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

### Removed

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
