# Changelog

> **Cutoff: 2026-08-28.** Nothing before that date is carried here. 1,034 lines were removed in
> `3df9a8e9`; the owner decided on 2026-08-31 not to restore them, and that decision stands rather
> than being revisited each time someone notices the gap. They are readable at
> `git show 3df9a8e9^:CHANGELOG.md`. Later cuts trim the same way: git is the record of what
> shipped, and this file is the short reader-facing view of the recent end of it.

## [Unreleased]

### Security

- **Every response to a personal access token now names the permission the route required.**
  Finding out what a route wants used to mean being refused on it: the name was in the body of a
  `403 PAT_PERMISSION_REQUIRED` and nowhere else, so the only way to a correct grant was to mint a
  token, exercise every path, collect the refusals and narrow by trial — and a request that
  *succeeded* said nothing at all. A REST request whose token verifies through the PAT grant fence,
  on a path some permission covers, now carries
  `X-Accepted-Forge-Permissions: <resource>:<level>`, on the `200` and on the refusals alike,
  named after GitHub's `X-Accepted-GitHub-Permissions` and valued in the same spelling
  `POST /api/pat` accepts, so it can be pasted into a mint request rather than translated. It is in
  the CORS `exposeHeaders` set, so a browser can read it. **A path no permission covers carries no
  header rather than an empty one** — an empty value would read as "this route requires nothing"
  on exactly the routes a PAT may never reach. The header cannot disagree with the fence, and that
  is a property of the code rather than of care: `beginPatRequest` resolves the name once and hands
  that single value to the header, to the grant check and to the refusal body's `details.wanted`,
  and `patGrantCovers` now takes the derived permission instead of a path, so it can no longer
  resolve one itself. Nothing about reachability changed — no token gains or loses a path, and the
  three refusals keep their codes and messages. Third of the seven phases ISS-972 carries.

- **A personal access token now reaches only the permission groups it was granted.**
  Phase 1 built the menu and nothing consulted it: every PAT reached the same 16 prefixes, because
  `patAllowedFor` tested the path against the union of the whole menu and never against anything
  the token itself carried. `personal_access_tokens.permissions` now holds the names a token was
  granted, `POST /api/pat` accepts them as an array validated against the menu (so an operator
  picks from it and cannot invent a group), `GET /api/pat` reports them back, and a rotation
  carries them onto the new row. A request outside the token's groups is refused
  `403 PAT_PERMISSION_REQUIRED`, naming both the permission the path wanted and the ones the token
  holds — a grant set is invisible from the caller's side, and a bare refusal makes narrowing a
  token something nobody does twice. **A token granted nothing reaches every group, not none**, and
  "nothing" has three shapes held to one answer: a `NULL` column, an empty array, and a principal
  built without the field. The migration writes no values, so every token that existed before it
  ran — 26 active human tokens, 25 of them immortal — keeps exactly the reach it had; reading an
  ungranted token as permissionless would have locked every live integration out on deploy. The
  opposite direction is deliberate: a *non-empty* grant naming only groups the menu no longer
  declares reaches nothing rather than everything. `patAllowedFor` is renamed `patSurfaceCovers`,
  because it answers the route's question and never the token's, and the scope word keeps its own
  job — `read`/`write` still gates the method, independently, and both gates must pass. Second of
  the seven phases ISS-972 carries.

- **Every REST route a personal access token can reach is now proven to be fenced, by a gate.**
  `PAT_ALLOWED_PREFIXES` decides which paths a PAT may reach, and its guard admits a prefix only
  where a project-scoped token can be *fenced* on it — but the list is per-prefix while the property
  it claims is per-route, and nothing checked the routes. One unfenced handler under an admitted
  prefix is a token reading another project's data with every line around it looking correct.
  `scripts/check-pat-surface.mjs` now walks every route under every allowlisted prefix and passes it
  only where the handler reaches the fence (`effectiveProjectRole`, `loadProjectAccess`,
  `assertProjectAccess`, `resolveProjectIdFromSlug`) — resolving the transitive intra-core import
  graph and each router file's own helper fixpoint, so a file-local `assertMember()` counts and a
  service layer two hops away counts, while a module that merely sits in the same import graph does
  not. It reports `7 resource(s) · 14 permission group(s) · 16 covered prefix(es) · 67 router
  file(s) · 202 route(s) · 0 finding(s)`, and refuses to pass vacuously: zero routes checked exits
  2, an unparseable route path is a finding, a partially parsed declaration exits 2 rather than
  walking the part it understood, and a stale exemption is a finding. Registered on `verify`'s
  `knowledge` axis and as a CI step.

- **Which routes a personal access token may reach is now declared as named permissions.**
  `PAT_PERMISSION_RESOURCES` in `packages/core/src/auth/pat-permissions.ts` maps a resource
  (`issues`, `tasks`, `pipeline`, `knowledge`, `skills`, `schedules`, `projects`) to the `/api/...`
  prefixes it covers, and the menu is those seven crossed with the two levels the method test
  already answers — `issues:read`, `issues:write`, and so on, 14 permissions. `PAT_ALLOWED_PREFIXES`
  is now that map's union rather than a hand-kept list, so widening what a token may reach means
  editing a named permission instead of an array, and the menu is code an operator picks from
  rather than configuration an operator can extend: a route group somebody can invent is a fence
  nobody proved. **Nothing a caller can observe changed** — the union is the same 16 prefixes, held
  to that by a test that freezes them as a literal, and no request consults a permission yet. A
  group's level is the value `scopeForMethod` returns rather than a list of verbs, so every method
  is classed by exactly one level and the two levels of a resource cover it between them by
  construction; an enumerated verb list would instead have narrowed reachability for the first
  method nobody thought of, silently, because the path test is method-blind. First of the seven
  phases ISS-972 carries; a token starts carrying its own grants in the next one.

- **Six vulnerable transitive dependencies pinned to patched versions, closing 19 Dependabot alerts
  (12 high).** `fast-uri` (→3.1.7), `undici` (→7.29.1), `qs` (→6.16.0), `protobufjs` (→7.6.6),
  `brace-expansion` (→2.1.4) and `nanoid` (→3.3.18) each resolved below the first-patched version of
  its advisory. Four `pnpm.overrides` were stale — lower bounds written before the CVEs
  (`qs>=6.15.2`, `undici>=7.28.0`, `protobufjs>=7.6.3`, `fast-uri>=3.1.2`) still admitted a
  vulnerable release — and `brace-expansion`/`nanoid` had no override at all. The two new overrides
  are scoped to the vulnerable major line (`brace-expansion@2`, `nanoid@3`) so the pin cannot
  silently carry a consumer across a major. CodeQL code scanning and GitHub private vulnerability
  reporting were enabled on the repository in the same change.


### Added

- **The chat tool catalog now has a price, and it is re-derivable rather than quoted.**
  `pnpm --filter @forge/core measure:catalog-cost` builds the live catalog through the same call the
  chat routes make, serializes it by calling `toRequestBody` itself so what is counted is what the
  wire carries, and prints its size, the input-side cost of one request cold and warm at two
  history lengths, and — given `FORGE_CENSUS_DATABASE_URL` — how many logged chat requests ever came
  back reporting a cache read. It also prints the worked case the estimate rests on: two requests
  with an identical cached catalog and different history lengths report aggregate
  `cachedPromptTokens / promptTokens` ratios a factor of 3.6 apart while saving exactly the same
  tokens, which is why that ratio cannot price a prefix. The report it feeds is
  `docs/modules/agent-execution/tool-catalog-cost.md`. **What it found: nothing in this fleet has
  ever cached** — 0 of 79 `chat_logs` rows carry `cachedPromptTokens` at all, every one of them is
  `gemini/gemini-2.5-flash` over the Completions wire, and no chat request has been logged since the
  Anthropic adapter became the default, so the path that asks for caching has never run here. Any
  saving argued from a cache-hit rate on this deployment was argued from a number that does not
  exist. Figures the host could not measure are labelled as estimates and named as such, and the
  census says in its own output which grouping it could not produce before it prints the narrower one
  it can — `chat_logs` records `model` and no provider column — and a census that cannot run at all
  is said and exits non-zero rather than being skipped past. It runs with nothing configured: sizing
  the catalog reaches the tool registry and therefore the validated environment, so the entry point
  fills the three variables that have no default with inert placeholders, says on its own first line
  which ones it filled, and reads the census database from `FORGE_CENSUS_DATABASE_URL` and nowhere
  else — a measurement of a constant that demanded a production database to start would not be
  re-runnable, which is the whole of what it is for. It also separates the two doors, which is where
  the headline figure went wrong: the 28,343 characters the proposal costed is the **uncapped**
  serialization `/mcp` serves, while the chat door truncates every description at 1,024 and is served
  20,134 — of which only 7,157 is description at all and 12,977 is schema that no prose trim reaches,
  with five of the nine tools already sitting at the cap and giving nothing back when shortened.

- **A chat-channel speaker now resolves to a Forge user, or is refused by name.** A person speaking
  in a Rocket.Chat room reached Forge as a display name and nothing else, so a reply typed there
  could not be an authorized act of any kind: answering a parked question and authoring a comment
  are both gated on a real Forge user, and a channel supplies none. A speaker is now mapped to
  exactly one Forge user by a confirmed row, keyed on the channel, the installation and that
  installation's own stable user id — never on a username, which the next holder of that name would
  inherit. A speaker with no row is refused with what was wrong, who was not found and the step that
  fixes it, and there is no fallback identity anywhere on the path.
  **A person links their own account in four requests**, without anyone touching the database: a
  proposal lists the Forge users whose address the chat server reports for that speaker and writes
  nothing, the confirmation is made by the person being mapped while signed in themselves, and both
  are refused before the project's chat credential is read for anyone who is not a member of it.
  A candidate whose address merely shares a local part with the speaker's is shown and cannot be
  confirmed. Unlinking removes the row rather than disabling it. Nothing yet reads the map — it is
  what a question or a comment delivered to a room will be authorized against (ISS-977).

- **A decision a run parked on is now readable and answerable on the issue itself.** When an agent
  stops and asks, it writes a structured question: a prompt, a set of options, which one it
  recommends, and for each option who may choose it, how far the choice reaches and who carries it
  out. All of that has been on the record since the park was built, and there was no screen for
  any of it — the only thing a person saw was a banner saying a question had been left in the
  comments. The issue page now renders the decision above the pipeline tracker: every round it has
  been through, the current round's options with what each one actually commits you to in plain
  words, and a button on each one. Choosing tells the run, which picks the answer up and carries
  on. **An option you may not choose stays on the screen, greyed, saying which authority it
  needs** — it is not hidden, because a queue of decisions only one person can even look at is how
  a decision sits for a week. The Attention inbox marks the rows that carry one, so a decision
  somebody can settle in a click is no longer indistinguishable from work that was paused by hand.
  A question aimed at another machine rather than at a person renders as a record and offers no
  button. An answered, withdrawn or expired question shows what became of it.

- **An operator can now read any console glance metric as a full time series, not just its current
  value.** `GET /api/admin/metrics/:metric/timeseries` answers the history behind a glance figure
  over the console's existing `24h | 7d | 30d` windows, for the same five metrics the console
  already shows — lead time, interventions per closed issue, cost per closed issue, success rate
  and signups. Until now a number that moved could only be guessed at from two points: the console
  published one value, one arrow and a 24-point spark, and the full series those sparks were
  sampled from existed for the length of one request and was then discarded. The response carries
  every bucket of the window and the equal window before it, oldest first, so the figure and the
  shape behind it are read from one answer. A bucket where nothing happened is reported as such: a
  ratio nobody could compute reads `null`, distinct from a ratio that genuinely was zero, while a
  count with no rows reads `0`. The glance keeps every figure it published before — its spark is
  now literally the recent tail of this series rather than a parallel reading of the same rows, so
  a tile and its history can no longer come to disagree. It is admin-only and cross-tenant like the
  rest of the console, and reaches no personal access token. The last deliverable of the Operator
  Ops Console epic, which shipped the rest of its surfaces earlier.

- **A session now tells the box what it is doing, instead of the box guessing from its screen.**
  Every agent Forge starts registers its own Claude Code hooks, so the runner learns when a turn
  began, when it ended (including when it ended on a model error), when a child agent is still
  working under a finished parent, and when the agent has stopped on a question only a person can
  answer. Until now the only thing the box could observe was that it had typed something into a
  terminal: a pane emits no turn boundary, so "the message was delivered" could never mean "the
  agent read it". Measured on the maintainer's box the day this shipped: 16 sessions were holding an
  instruction that had been pasted into their prompt and never submitted — all 16 recorded as
  delivered — and one more had been stopped on a dangerous-command confirmation for hours while
  every liveness check called it healthy. That last case is now a warning naming the session the
  moment it happens. Hooks are merged into the session's own settings, so anything already
  configured there keeps working, and a session whose hooks cannot be installed still starts — it is
  simply as blind as every session was before.

- **Agents are no longer told to walk a pipeline that was retired.** The default forward chain every
  agent reads was still `open → confirmed → clarified → approved → developed → testing → tested →
  …`, and agents followed it: 153 status changes across four projects in three hours, each landing on
  a rung where no work is dispatched. 45 issues were sitting on one of those rungs, waiting for a
  person who did not know they were waiting. The chain is now the four rungs that actually run, and
  the six retired names are called out by name — they still exist for the issues already on them, so
  writing one succeeds silently, which is exactly why the warning had to be explicit.
- **The status for "merged, waiting to be released" is now called `awaiting_release`.** It was
  called `released` — the past tense of an action that had not happened, so every reader had to know
  that "released" meant "not released". The board has shown this rung as *Awaiting release* all
  along; only the underlying status disagreed. It carried a second job too: with no release button,
  moving an issue to `released` was how a release *started*. That job now belongs to the RELEASE
  button and to `releasing`, so the rung can just be a place where work waits.
- **A release you trigger now has a status of its own while it runs.** An issue whose release batch
  is executing sits at `releasing` instead of standing at `released` looking like it is still waiting
  for someone to press the button. Nothing offers it to a master, nothing dispatches over it, and the
  board reads *Running* rather than *Awaiting release* — so a person cannot trigger a release that is
  already in flight. When the batch finishes the issue closes; when it aborts, the issue lands at
  `reopen` with the reason attached and waits for a person, and `merged_at` is not stamped on the way
  in, so a half-landed batch never reads as shipped.
- **A release that dies half-way hands its issues back instead of parking them nowhere.** If a
  batch stops without either finishing or aborting — its job failed, someone cancelled the run, the
  box went away, or a second batch was already in flight — every issue it was holding lands at
  `reopen` with the reason on it and a comment saying so. Previously the batch let go of the issues
  and said nothing about them, which was harmless while they stood at the release gate and would now
  leave them mid-release with nothing able to move them.
- **A reopened issue reads as reopened.** `reopen` renders as its own label instead of borrowing
  `open`, which promised a dispatcher that no longer comes: an agent's `reopen` is no longer rewritten
  to `open` on an autonomous project, because a person disagreed with a close and a person routes what
  follows.


- **An agent that needs your decision now asks you and gets out of the way.** When a run hits
  something only a person can settle, it writes the question down, releases the machine it was
  holding, and stops — keeping its branch, its working copy and its place in the work so it can pick
  up exactly where it left off. The question appears in your queue with a recommended answer already
  chosen, so the usual case is one click, and the queue is ordered by what the waiting costs rather
  than by what arrived last: a question holding two machines and blocking three other issues sits
  above one holding nothing, and each row now shows those numbers and who can end the wait, so the
  order can be checked rather than trusted. Answering is enough — nothing else has to be poked, and
  the boxes serving that project are told the moment you do. Your answer belongs to the question and
  not to whoever was waiting on it, so one answer releases everything that was blocked on it, and it
  stays on the record if the work has to be picked up by something else later. A question nobody can
  answer is no longer filed as a question at all: it fails with a name.
  While a run is parked it holds no agent and burns nothing, and it survives its box rebooting, its
  supervising agent crashing, and the browser being closed on it — none of which used to be true, and
  each of which used to end with the work quietly thrown away. If a question goes unanswered past the
  deadline the asker set, the run closes loudly and says how long it waited, with the diff saved
  before the working copy is released; a question with no deadline waits indefinitely on purpose and
  is never closed out from under you.
  The project's Agents screen was rebuilt around what a run is actually doing: whether an agent is
  working, waiting on a machine, parked for a person, or — the state nothing could previously show —
  answered and waiting to be restarted. Three separate wind-down steps that used to read as one flag
  now read as three, so a run whose agent has finished but whose working copy is still on disk is
  visibly recoverable instead of looking finished.
  And the counterpart of asking is now on the record too: an agent notes each reversible thing it
  decided for itself rather than interrupting you for, so how much it asks can be read against how
  much it settled alone. Without that second number a pass that asked twice and decided forty things
  looks the same as one that asked twice and did nothing else.

- **You can now see which agent sessions a box is running without logging into it.**
  `GET /api/projects/:id/run-sessions` answers any member of the project with every run the fleet is
  holding for it: the run's own worktree and process id, the master session that started it, the
  issues it carries and which of their leases have come back, and whether the box reads the run as
  live, waiting or finished. Until now the only record of any of that was a SQLite file on the box
  itself — core did not know, the web UI did not know, and another machine had no way to ask. Each
  box reports its whole registry every twenty seconds over the websocket it already holds open, and
  again the moment a dropped connection comes back, so a stale answer is impossible to mistake for a
  fresh one: every row carries the time its box last spoke. Last activity is read from Forge's own
  record of the session rather than from the box's report, so a box that has gone quiet while
  claiming to be busy shows up as exactly that. A run recorded before this change, which has no
  project on it, is named in the box's log and left out rather than published into a project it may
  not belong to.

- **A deploy that builds but cannot serve is now caught and undone without a human.** Give a Coolify
  deploy target a health URL in its integration settings and Forge reads that URL after every deploy
  to it: a grace period, then polling for up to five minutes. Healthy means the app answers `200`
  with `ok: true` — a connection that is refused counts as unhealthy rather than as no answer, which
  is what the 2026-09-07 pg-boss crash-loop actually looked like from outside. A target that never
  goes healthy inside the window fails its deploy, records which deployment failed and on what
  signal, and is rolled back to the previous image Coolify still lists. The rollback is health-checked
  too; one that also cannot serve is reported loudly and never rolled back a second time. Targets
  with no health URL deploy exactly as before, and a build that finishes too close to its own
  confirmation deadline to be given that grace period is left unproven and said so, rather than
  failed on one reading of a container that is still starting.
- **A runner can now clone and push a GitHub repository with no deploy key, using the GitHub App
  the project already connected.** Picking a repository in the GitHub card fills
  `projects.repo_url` (`https://github.com/<owner>/<repo>.git`) so it is chosen once rather than
  retyped, and `forge-runner git-credential` — a git credential helper — asks
  `POST /api/devices/me/git-credential` for an installation token on every fetch and push.

  **A helper, not a stored credential, because an installation token lives one hour and jobs do
  not.** The provision side-channel delivers once, and `auth/git_cred.rs` writes a *static* line
  into a `store --file=` helper, so a token handed over that path goes stale mid-job and git keeps
  presenting the expired one as a rejected password. The helper is asked per invocation, stores
  nothing on the box, and emits `password_expiry_utc` so git >=2.34 drops its own cache at the right
  instant. Provisioning puts the required config entries on the clone command line, because there
  is no repo yet to hold them, then repo-locally for every later fetch.

  **It resets the helper list before adding itself, and that is load-bearing.** Git asks
  `credential.<url>.helper` entries in config order — system, then global, then local — so on a box
  where anything else configured one (installing `gh` does) the ambient helper answers first and the
  push lands as that identity. Measured 2026-09-08 on this repo's own checkout: `git credential fill`
  for `SidCorp-co/epodsystem_cli` returned a personal `gho_` token while this helper was configured
  for it. With the empty-value reset first, git asks nobody else and fails loudly when the App path
  cannot answer, which is the whole point of routing git through a project's own credential. The
  reset is proven twice, because `-c` flags and a config file are different code paths in git and
  only the file half governs every fetch and push after the clone: one test reads the checkout's own
  config back, and one plants an ambient global helper in a temp repo and fails if it is the one that
  answers.

  **The integration is a capability and never a requirement.** Which credential is used follows the
  remote's transport, not whether an integration exists: an `ssh://`/`git@` remote takes the
  project's deploy key exactly as before, an `https://` remote takes an App token only when core
  says a binding with an installation exists, and a project with no GitHub integration provisions
  with no extra step. The absent `githubAppCredential` field reads false, so an older core cannot
  turn the helper on by omission.

  What the device may reach is recomputed on every ask from the projects it actually runs — the
  `runners.device_id` join is what keeps a paired box from minting a token for every repository
  bound anywhere in the fleet, which is narrower than the deploy keys this replaces. Removing that
  join turns `a repository bound to a project this device does NOT run` red.

  The App manifest now requests `contents: write` rather than `contents: read`; **an App created
  before this change can clone but cannot push** until its Contents permission is raised in the
  App's settings and the new permission approved on each installation. That arrives as HTTP 403,
  which is a permission to grant and not a credential to replace.


- **Forge now reports the module pairs your issues keep linking that your module hierarchy never
  declares as connected.** `GET /api/projects/:id/modules/drift` compares two edge sets over the
  same nodes — *observed*, a self-join of `issue_labels` scoped to `kind='module'` on both sides,
  and *declared*, the transitive closure of `labels.parent_id` — and reports the difference in both
  directions, weighted by the number of issues each edge rests on, with the five highest issue
  numbers as the evidence to open. A pair seen on a single issue is a coincidence, not a finding, so
  the threshold defaults to 2 (`?minCoOccurrence=n`).

  **It is a signal and it can fail nothing.** No gate reads it, there is no threshold that 4xx's,
  and every legal state including "this project declares nothing" is a 200 body. A detector that
  could fail a build would be answered by declaring edges nobody means, which would cost the
  declaration the value the signal measures against.

  Three things the report states rather than leaves to the reader: `layer: 'module-taxonomy'`, so
  it is not read as a claim about `.arch.json`'s 63 source-path globs (a different granularity,
  gated on the `relations` axis, which this neither reads nor becomes an authority over);
  `declaration: { state: 'absent' }` for a project with no hierarchy, which is a legal and common
  state and not zero drift; and `nearestCommonAncestor` on every finding, so two cousins under one
  parent read differently from two modules in unrelated subtrees. `knowledge_edges` is deliberately
  not read — it is a free-text triple store with no module convention, and reading it as one would
  invent the second declared-edge store this issue exists to avoid. (ISS-951)

- **A project can require a typed component on comments written at a stage, and read how many
  already carry one before deciding to.** `pipelineConfig.states[stage].bodyPolicy.requireComponent`
  names a root component (`forge-outcome`, `forge-review`, …); an agent's comment written at that
  stage without it is refused with `BODY_COMPONENT_REQUIRED`, naming the component, the stage and
  what to write. **Off everywhere** — absent from the shipped defaults and from every stored
  document, so nothing changed for any project until an operator sets it. A person writing prose is
  never refused, at any stage, under any policy. `GET /api/projects/:id/body-adoption` answers the question that
  used to need SQL by hand — per stage, what fraction of bodies carry a component over a window —
  counting what is STORED (`format='html'` plus the root component) rather than a regex over body
  text, and Project settings → Pipeline shows the figure beside the switch. Two new columns on
  `comments` make that measurable: `stage`, the issue's status at the moment of the write (grouping
  by its *current* status would file every agent comment under `closed` and leave `open` reading
  empty), and `author_agency`, the door's own principal — the gate and the number read the same
  column, so the fraction always describes the rule that exists. Measured when this shipped: zero
  comments fleet-wide are agent-authored, because the agent accounts ISS-932 wave 4 introduced are
  not provisioned yet, so the switch refuses nothing and the number counts nothing until they are.

- **The backlog can be read by module: counts, open and closed, and recent activity.** Tier 2
  shipped the `?module=` filter, which answers "show me the issues in module X"; nothing answered
  "which module is hot" or "what is open against each". The Issues screen has a fourth view,
  **Modules** (`?tab=modules`), listing every module of the project with its total, open, closed
  and recently-active counts, and `GET /api/projects/:id/modules/rollup` serves the same numbers.
  Primary and secondary attributions are counted and shown separately — an issue has one primary
  module and any number of secondaries, and summing them would lose the distinction. A parent
  module's counts say which part is its own and which is inherited from its children, with an
  issue attributed to both counted once. A module with no issues appears with zeroes rather than
  vanishing, and the issues carrying no module at all are their own row rather than being dropped.
  The aggregation reads `issue_labels` joined to `kind='module'` labels and nothing else: there is
  no second store of module membership. Flow:
  [`docs/flows/issue-work.html`](docs/flows/issue-work.html).
- **A project's four module diagrams — mindmap, context, user flow and swimlane — are now generated
  from its module taxonomy instead of drawn by hand.** `GET /api/projects/:id/module-diagrams/:kind`
  computes the Mermaid inside the request from the `kind='module'` labels and the knowledge nodes
  bound to them, and the Knowledge screen carries a **Diagrams** tab that renders it. There is no
  cache and no schedule, and that absence is the point: a diagram cannot be quietly older than the
  node it claims to render, because nothing sits between the rows and the answer.

  The mindmap follows `parent_id` and carries each bound node's related-issue count; the context
  diagram draws modules as nodes with dotted edges for issues a pair shares and solid ones for
  live `knowledge_edges` triples whose two ends both name modules; user flow and swimlane read the
  Mermaid flow stored in each node's body, grouped by module and by the node's `metadata.actor`
  respectively. A module with **no** knowledge node still appears, with its name and its place in
  the hierarchy and no count — it is neither skipped nor an error.

  A generator that cannot draw what it was asked for **says so by name**: `NO_MODULES`,
  `NO_MODULE_FLOWS`, and `UNPARSABLE_MODULE_FLOW` naming the module whose stored flow it could not
  read. None of the three answers with a partial picture that looks complete. The standing
  `product-map-refresh` schedule keeps authoring its overview / scenario / workflow entries and no
  longer claims the four generated kinds, so those kinds have exactly one owner. (ISS-950)


- **An issue or comment written as `forge-*` components now renders as components, and a
  description can be corrected after it was created.** The registry, the validator and the four
  columns shipped in ISS-898, but nothing drew them: a body stored as components reached the
  browser as the projection's plain text, so the one surface a person reads was the one that did
  not show the shape they wrote. Twenty issues on the fleet already carried raw `<p>`/`<div>`/`<img>`
  that rendered as literal text.

  The scanner and the registry stay core-internal — `packages/web-v2` has no dependency on
  `@forge/core` and cannot parse a body — so **core parses and the read paths hand back the node
  tree**: `GET /api/issues/:id` carries `descriptionNodes`, and every comment carries `nodes`.
  Both are `null` for a markdown row, which is every row written before this. A markdown body
  renders exactly as it did.

  Web holds **no component list at all**. `forge-diagram` draws as a mermaid diagram and
  `forge-artifact` as an attachment card; every other `forge-*` draws one generic block with its
  attributes and its slots. So a build that has never heard of a component and a build that used to
  know it render identically, and neither draws a blank — the rollout case is ordinary rather than
  broken.

  Two new reads back the composer, both without touching a row. `GET /api/body/components` is the
  registry itself, so the insert menu offers exactly what a save accepts and there is no second
  list to drift. `POST /api/body/preview` runs the same `prepareBody` a save runs, so the preview
  pane shows the bytes that would be stored and, on a bad body, the kernel's own 400 naming the
  element, the attribute and its legal set.

  `PATCH /api/issues/:id` has always accepted `description`; the browser never sent it. The
  Description card now has an Edit control for anyone who may write, with the same insert menu and
  preview pane, a toast on both outcomes, and a Cancel that restores the stored body. The knowledge
  rules tab's preview and the composer's are now one component.

- **A running instance now names the commit it was built from, and an error can be attributed to
  the deploy that introduced it.** `GET /version` answered `{ version, uptimeSeconds }` where
  `version` was the package version — `0.3.0` for every deploy this repo has ever made. Two
  different builds read minutes apart returned the same string, and `uptimeSeconds` was the only
  field that distinguished them, which tells you when a process started and not what it is. The
  same defect ran the other way through Sentry: the release was `forge-core@0.3.0`, so hundreds of
  deploys reported as one release and suspect-commit resolution had nothing to resolve against.

  `/version` now carries `sourceCommit`, and both Sentry surfaces take their release from that
  same value. There is one writer: the `SOURCE_COMMIT` build argument in
  `docker-compose.prod.yml`, which core freezes into its runtime image and web-v2 inlines into the
  client bundle above `pnpm build`. Two independent reads of "which commit is this" are two things
  that can disagree, and the disagreement would be silent.

  **A build that was not told its commit says so.** `sourceCommit` is `null` — the key present,
  the value null, never an empty string, `unknown` or a placeholder — and Sentry attaches no
  release at all. So is any value that is not 7 to 40 hexadecimal digits: the deploy platform's
  own application row reads `git_commit_sha=HEAD`, so the literal `HEAD` and an unexpanded
  `${SOURCE_COMMIT}` are values a build can really receive, and an identity nobody can look up is
  worse than an admitted gap. `version` and `uptimeSeconds` keep their exact meanings, so no
  existing caller of the route changes.

  `.github/workflows/sentry-release.yml` registers each merge commit as a release for both Sentry
  projects and associates it with its commits, which is the half that lets Sentry name a suspect
  commit. It needs a `SENTRY_AUTH_TOKEN` repository secret and says in the run summary when that
  secret is absent rather than failing — the release ids are already correct without it.

- **Issue search now reaches `plan` and `acceptanceCriteria`, and names the field it matched.**

  `filters.search` (MCP `forge_issues action=list`) and `GET /api/projects/:id/issues/search`
  reached the title and the description only, so a requirements-clause citation written beside the
  criterion it proves — `FR-05~2` on an acceptance criterion — was unfindable, and the only way to
  answer "which issues cite this clause" was a full walk of every issue, which does not fit inside
  an agent's token budget on a single project.

  All four text fields are now searched, by literal substring and by the identifier split
  (`cascade` finds `runs-cascade.ts`), and every matching row carries `matchedFields` naming which
  of them matched. The read stays bounded: the same paging, the same `hasMore`, no new route. The
  generated `ident_search` column widens with it (migration `0220`), so the identifier arm cannot
  quietly cover fewer fields than the substring arm.

  `forge_issues action=list` also now REFUSES `filters.issue` and `filters.taskStatus` by name.
  Both belong to `listTasks`; `list` accepted and dropped them, and at `limit: 1` the result was a
  well-formed single row of an unrelated issue, indistinguishable from a successful lookup.

- **A write to an issue's session field can now carry the value it read, and is refused when the
  field moved underneath it.** `sessionContext` is where a driver's lease lives, and until now a
  write always won: two runs that both read no holder both claimed, and the later write erased the
  earlier with neither able to tell. The CLI said so out loud on every claim — *"the lease is
  advisory: the tracker refuses no stale write yet"* — and carried the whole rule client-side,
  where nothing could enforce it.

  A `PATCH /api/issues/:id` (and MCP `forge_issues.update`) may now send
  `expect: { sessionContext: <what it read> }`. The precondition is a term in the same `UPDATE`'s
  own `WHERE`, never a read above it: a check placed there is the exact race this closes, because
  two writers that both read the same value both pass it. The loser gets `409
  SESSION_CONTEXT_MISMATCH` carrying, under `details.current`, the value the field holds now — a
  bare refusal would leave it one move, a blind unconditional overwrite, which is the write being
  prevented. A write with no `expect` behaves exactly as before, so every existing client keeps
  working, and an `expect` sent with no field to write is refused on both doors rather than
  ignored — it holds nothing against a status or relations change, and a caller who read the call
  as guarded would be wrong.

- **The merged mark now records the commit it was made at.** `merged_at` was a bare timestamp, and
  the commit lived in the prose of the mark's note — so "did THIS commit land?" was a judgement
  call a reader could not check, on the one field that releases every `blocks` dependent as if the
  work had shipped. `issues.merged_commit_sha` is written by the same conditional statement that
  sets the timestamp, so the pair is stamped together or not at all and the sha always belongs to
  the call that actually stamped it rather than to a later corrected note. A caller that sends no
  `commit` gets the sha off the recorded implementation handoff, which is the only commit core can
  know — core has no checkout, so this is a recorded claim and not a verified ancestor, and the
  module says so. `unmark` clears both columns together, because a retracted mark that kept its
  commit would claim a landing the retraction withdrew.

- **A project can declare which records a status entry requires, and the declaration is checked for
  every client.** Every content rule on the status writer returned early unless the actor was an
  agent, so the same status set from the tracker's own screens was neither earned nor refused —
  measured twice on forge-dev the day this was written, when an ordinary `forge record` write and
  an ordinary `forge comment` write each moved an issue from `needs_info` back to `open`. On a
  project where `open` is what makes an issue claimable, that silent un-park is a live path to two
  agents on one issue.

  `pipelineConfig.statusEntryCriteria` maps a status to the records its entry requires, from a
  vocabulary core implements: `plan`, `acceptance_criteria`, `release_note`, `work_evidence`,
  `merged_mark`. Every key reads the tracker record and never a working tree — a check that read a
  checkout would answer differently on every machine that ran it. An unmet declaration is `422
  ENTRY_CRITERIA_UNMET` naming the records that are missing and how to write each one, and naming
  only what is unmet rather than everything the status declares. Which criteria a status carries is
  the project's decision, not core's: a project that declares nothing is unchanged, and a config
  that cannot be read declares nothing rather than freezing every status write on the project.

  `no_work_evidence` stays agent-only, and the carve-out moved from the whole checker onto that one
  rule: a person hand-advancing makes the shipped claim deliberately and owns it. A project that
  wants it held against people too declares `work_evidence`.

- **The MCP deletion rule was written against per-tool call counts nothing could read, and now
  there is a route that returns them — deliberately not one an agent can call.**
  `docs/architecture/agent-surface.md` gates every tool deletion on whole-table `mcp_audit_log`
  counts, and the only route over that table was `GET /api/pat/:id/audit`: one token, last-N rows,
  behind a prefix that is off `PAT_ALLOWED_PREFIXES` by design. So the rule's own instruction —
  *"must not delete on an estimate"* — could not be satisfied by anything short of a psql session
  and a hand-written query nobody reviewed. `GET /api/admin/mcp-audit/tools` now answers it:
  `deviceCalls`, `tokenCalls`, `unattributedCalls`, `notFoundCalls`, `totalCalls`, `firstSeen` and
  `lastSeen` per tool, whole table, no date filter, no request bodies or ips.

  Three things about the query are the finding rather than the plumbing, and each is a defect this
  rule has already shipped. The split is on `device_id` / `token_id` and **never** `user_id`, which
  is stamped `device.ownerId` for a device caller and so reads 100% user for every tool — the
  reading `7f0c5a56` deleted six live tools on. The spelling is normalised on both sides, because
  agents send the underscore form their MCP client shows them and a query for the dotted name finds
  none of those rows. And the registry is **FULL OUTER** joined to the aggregate: a tool nothing has
  ever called has no row at all, so an inner join drops exactly the tools the rule is hunting, while
  a name that was called but is not registered has no registry row and is itself a finding. All
  three go red under a real Postgres when reverted.

  **It is admin-only, and that is the decision rather than a shortfall.** A per-tool count spans
  every project on the instance, so the route resolves no project for the PAT fence to bite on —
  the `/api/me/ops-health` shape, which `PAT_ALLOWED_PREFIXES` exists to keep out. A project-scoped
  twin is refused by name: a tool idle in one project and busy in the next would read *clear*, which
  is not a smaller version of the evidence but the same substitution in a new coat. So the rule is
  two-party from here — an agent on a box gathers the refusals, which are static and greppable
  there, and a human with admin runs this route for the clearance. `/api/admin` and `/api/pat` are
  now held off the allowlist by an assertion instead of by prose.

  The counts are lifetime counts only while `enforceMcpAuditRetention` stays unwired, and the route
  does not merely claim so: it returns `oldestRow`, so a reader sees the window rather than trusting
  a paragraph. (ISS-946)
- **A module's knowledge now refreshes itself when work lands against it.** The taxonomy could say
  which module an issue touched (ISS-588) and a module could name its knowledge node (ISS-947), but
  nothing kept that node current: its related issues stayed at whatever the last person wrote, and
  no reader could tell a current flow diagram from a stale one. One project wired the refresh loop
  inside its own skill body; everywhere else it simply did not happen.

  A `test` handoff whose result is `pass` or `verified_by_test` now refreshes the primary module's
  node — the issue is appended to its related issues, and the node records that its stored flow is
  behind that work and since when. Modules the issue also touched get the append and nothing else.
  The trigger is the passing test rather than a status change, on purpose: a status is a claim
  somebody made, a green test is a thing that happened.

  Every declining case declines out loud instead of failing. An issue with no primary module
  refreshes nothing and that is not an error. A module with no knowledge node refreshes nothing and
  names itself in the issue's activity feed, rather than getting a node invented under a guessed
  name. The same issue landing twice does not append twice. And a refresh that fails is reported to
  the log and the activity feed without failing the pipeline of the issue that triggered it.

  What the engine cannot do, it does not fake: core has no LLM and no repo checkout when a handoff
  arrives, so it cannot redraw a module's flow diagram. It records that the flow is behind the work
  and which body it was behind as of, and leaves the drawing to whoever authors the node — a
  placeholder diagram nobody could tell apart from a real one would be worse than a stale one.

- **A module now names its knowledge node, instead of every reader guessing the name.** The module
  taxonomy (ISS-588) landed `kind='module'`, `parentId` and `is_primary`, but not the half of the
  epic's locked Q2 that every later tier reads from: a module had no stable identity and no link to
  the knowledge entry that documents it. The only answer available to "which node is this module's"
  was `module-${slugify(label.name)}` recomputed at each call site — the name-prefix convention the
  epic rejected by name, with the extra failure that renaming a module silently orphaned its node.

  `labels` now carries `slug` and `knowledge_entry_id`. The slug is the module's identity: derived
  from the name on create or on promotion, returned in the response, and never recomputed on a
  rename — so retitling a module cannot move what its node is found by. Two distinct names deriving
  one base (`API/v2`, `API v2`) get `api-v2` and `api-v2-2` rather than a refusal, and the migration
  backfills existing modules by the same rule written in SQL, so a module created before it and one
  created after answer to the same slug for the same name. The node link is 1:1 in both directions
  and enforced at the database, not only in the service: `labels_knowledge_entry_id_uq` refuses a
  second module naming one node, and the CHECK pair `labels_slug_chk` / `labels_knowledge_entry_chk`
  makes a plain label carrying either field unrepresentable. Deleting a node clears the link
  (`ON DELETE SET NULL`) rather than deleting the module; deleting a module leaves the node standing.
  A NULL link means "no node written yet" and never "the node is gone".

  Fixed on the way past: the labels routes reported every unique violation as
  `LABEL_NAME_TAKEN`, so with three indexes on the table a writer that raced onto the same
  knowledge node would have been told its label *name* was taken. `labels/unique-conflicts.ts`
  now answers by the index that fired, and rethrows an index it has not been taught about rather
  than folding it into the nearest code.

  Additive in every statement, and it ships with no consumer — the refresh loop, the generated
  diagrams, the rollup and the drift signal are ISS-589's children and now have one stored link to
  read instead of each re-deriving a name (ISS-947).

- **A status now says only WHERE the work is, and three row fields answer what exists.** Four runs
  on 2026-09-06 reached one identical real state — implemented, gates run, branch pushed, PR open,
  nothing merged — and recorded four different statuses (`developed`, `draft`, `waiting`,
  `in_progress`). None was careless: `developed` carried a **placement** promise from this repo's
  lifecycle guide (work built outside the pipeline enters at the review gate) and an **evidence**
  promise from the driver plugin's own contract (the mark is earned by the merged commit and the
  base it landed on), and direct-ship is where the two come apart permanently — placement is earned
  when the branch is pushed, the merge evidence is never earned at all by an actor bound not to
  merge. The generalisation underneath: the tracker had assumed the actor who finishes work can
  also land it.

  `pipeline/status-assertions.ts` now declares, exhaustively and per status, a `gate` and a
  `nextActor` — two fields, both placement, and no field in which a status could claim that code
  landed. A status added to the schema without an entry fails `tsc`, so the next rung cannot
  inherit the ambiguity by saying nothing. Evidence moved to three named row fields read directly:
  `merged_at`, `sessionContext.branch`, and the implementation handoff's `commitSha`. The
  agent-facing lifecycle guide says the same in the same words, and
  `docs/flows/issue-status-placement.html` draws it. No status was added: `developed` was already
  the right rung, and what made it unusable was a promise it should never have carried.

  One consequence worth stating: on this lane `open` is the only status a job dispatches at, so
  every other live status is already waiting on a person. That is asserted against
  `autonomousStepFor` rather than described.

- **A backlog row now says whether the work already exists.** The declared backlog (ISS-917)
  excludes an issue only when a job or a live run has been opened for it — and an issue built by
  hand mints neither, so a `draft` somebody finished and a `draft` nobody has touched arrived as
  the same row. `BacklogEntry` carries `mergedAt` and `branch`, raw, beside the raw
  `blockerStatus`/`blockerMergedAt` the same module already returns for blockers. No derived
  `shipped` flag, and a row carrying a merge mark is **not** filtered out: `merged_at` is
  caller-asserted, so it is a fact to hand the master, never grounds for the kernel to hide the row
  and take the decision away. Measured 2026-09-06 — ISS-931 sat at `open` with its code on
  `origin/main` and was still offered as the highest-scoring work on the project.

- **A `draft` somebody is already working can say so, without dispatching an agent into their
  worktree.** `draft → in_progress` was refused outright, and the only legal forward move — `open`
  — auto-triages and mints a `drive` job. ISS-933 therefore sat at `draft` with a green-gated PR
  open on it, because the honest move was no move. `in_progress` joins `DRAFT_EXIT_TARGETS` (now
  five), the web-v2 status menu offers it, and nothing is enqueued: the driver dispatches at `open`
  and nowhere else. The autonomous wedge pass cannot roll it back either — that pass requires a
  prior `drive` job row and a running issue run, and a draft worked by hand has neither.

- **Core now tells a box that a project has work, instead of the box finding out on its next
  poll (ISS-933, wave 1).** Until now nothing pushed: the runner daemon read every project it
  served on a 30-second timer, and that interval *was* the latency from an issue arriving to an
  agent touching it. Core now publishes a `master.wake` frame on each bound box's device room when
  an issue reaches `open`, `draft` or `released` — including an issue created directly at one of
  them, which never passes through a transition and would otherwise have been the silent half.

  The frame carries **no work**: no job, no token, no decision. It says "look now", and the box
  reads the pool through the same call its timer already used and decides for itself, so there is
  one path from "something might be there" to "the pool was read" rather than two.

  **The timer stays, and that is deliberate.** The websocket publish is fire-and-forget with no
  buffer and no replay, so a wake sent while a box is disconnected is gone with nothing recording
  that it happened. The poll is what makes a lost wake cost latency instead of costing the work.
  The third trigger covers the same hole from the other end: when the runner's socket comes back
  up it reads the pool once, because every wake published while it was down is unrecoverable.

  A burst coalesces rather than queueing — five issues arriving together produce one sweep, since
  the sweep reads the whole pool rather than the issue a frame named. An older runner ignores an
  event it does not know and keeps polling, so this ships without waiting for the fleet.

- **A master can see a declared backlog beside its claimable pool, and decide whether to pull one
  up (ISS-917).** Until now a master saw only `queued` jobs under a live `pipeline_run`. A `draft`
  issue has neither, so it was invisible to every master on the fleet and the only way to get one
  worked was a human moving it to `open`. A project may now declare
  `pipelineConfig.poolBacklog = { statuses, limit }` — the statuses whose issues appear to its
  masters as a **backlog**: visible, readable, and not automatically worked. Absent or empty is
  today's behaviour exactly, which is every other project on the fleet.

  Admitting a status does NOT make it run. A backlog row carries no job and cannot be claimed;
  `GET /api/devices/me/pool` answers it as a sibling `backlog` key that an older runner ignores,
  never folded into `items`. Turning one into work is `POST /me/pool/promote` — it moves the issue
  to the entry status and lets the dispatch every other caller uses produce the run and the `drive`
  job, then hands back that job's id so the master claims it through the path it already used.

  **Promotion does not bypass the entry gate.** With `states.open` disabled or set to
  `mode: 'manual'`, promote refuses `entry_gated` and the issue does not move — `manual` keeps
  meaning "a human presses Run". Admitting a status widens what a master may SEE, never what it may
  decide. Every refusal (`entry_gated`, `not_in_backlog`, `issue_busy`, `not_found`,
  `backlog_disabled`, `dispatch_failed`) is an ordinary outcome: HTTP 200 with `ok:false` and a
  named reason, the way a refused claim already answers, because an entry-gated project and a race
  lost to another master are both normal and neither should invite a retry loop.

  Declaring `draft` while the project's `intakeGate` is on is refused at validation naming both
  settings: the gate exists so a *human* approves every arriving issue, and a master that may
  promote drafts is that human. The rule lives in the config schema, so REST and MCP `forge_config`
  both hit it.

  `forge-runner pool list` prints the backlog as its own block with each row's raw status, priority,
  age and blocker facts and no promote/skip verdict, and `forge-runner pool promote <issueId>`
  turns one into work. **The runner versions and ships separately** — a box needs a build carrying
  this to see the block. Project settings → Pipeline carries the switch, the admitted statuses and
  the row limit, and states in copy that admitting a status does not make it run. The judgement
  itself — what makes one draft worth pulling up now versus leaving alone — is in the
  `forge-master` skill beside the blocker table, as raw facts and no verdict.

- **An issue whose pipeline run is paused now says so on its own screen, whatever its status
  says.** A run can be paused while the issue underneath it keeps displaying the stage it reached —
  `approved`, say — so the screen said nothing at all and the work read as in progress. It was not,
  and nobody was coming. The pause reached that screen through one door only: the gate on a
  *queued step*. An issue with no queued step had no door, which is most of them once the step that
  was running finished.

  The issue screen now reads the run directly. The banner names which pause is holding it — an
  operator's, or a machine reason with the stage it names — says who ends it, and offers **Resume
  run** for the ones a person ends. A pause this build has retired says so plainly and does not ask
  anyone to act, because the sweeper frees it on its next tick; promising a resume nobody performs
  is the failure this replaces, on the other side.

  The banner outranks the others deliberately. While a run is paused nothing dispatches, so
  "Approve" or "Provide info" would promise movement that cannot happen — an issue that is both
  waiting on a person and paused shows the pause, and the question stays in the comments below.

- **A Coolify deploy that is building the wrong thing can now be stopped from Forge.** Coolify has
  had `POST /deployments/{uuid}/cancel` all along; Forge had no path to it, so a bad build ran to
  completion and the only recourse was the Coolify UI. `forge_coolify_deploy action=cancel` and
  `POST /api/projects/:id/integrations/coolify/cancel` reach it, resolving the deployment from the
  explicit uuid or the integration's most recent one. A deployment Coolify has already finished
  answers 400 with its own sentence, which is returned as-is: nothing is reported cancelled that
  was not. The cancel is written to the delivery log like any other outbound action, and needs no
  new confirmation path — Coolify reports `cancelled-by-user`, which the deploy poller already
  reads as a failure, so the run settles on its next tick.

- **A rollback is an action Forge performs, against an image it has confirmed exists.** New
  `action=rollback-images` reads what a target can actually be rolled back to (with the running one
  marked), and `action=rollback` queues the rollback at a chosen image tag. A tag Coolify no longer
  lists is refused by name, and so is an empty list — Coolify answers an unreachable application
  server with an empty list and a 200, so the read that proves least must not be the one that lets
  everything through. Coolify itself does not check the tag against its own list, so this rule is
  Forge's. A rollback that Coolify accepts without queuing anything is reported as a failure, not a
  rollback. The rollback build is polled and audited exactly like a deploy.

- **A deploy target is picked from what Coolify reports instead of transcribed.** The Coolify
  settings section now lists the applications the credential can see — including on the create
  form, before the connection is saved, which is where the transcription used to happen — and each
  bound target shows the name, domain and branch/commit Coolify holds for it. A bound uuid Coolify
  does not list is called out in place, so a wrong binding is visible without opening Coolify.

- **Work you finished by hand can now say so, and the project's progress figure believes it.**
  `merged_at` is the claim that an issue's code shipped — it is what releases every issue blocked
  on it, and what separates *shipped* from *closed with no evidence it shipped*. Making that claim
  was reachable only from the CLI, MCP and REST; the web never called
  `POST /api/issues/:id/merge` at all. A person who merged something outside the pipeline could
  therefore only close the issue, and a close stamps `merged_at` inside its own transaction —
  a stamp the counter correctly discounts, because closing is also how a duplicate ends.

  The issue's Properties rail now carries **Mark merged** next to the merge date, with the
  target it landed on and an optional note, and **Unmark** to retract it. Both route through the
  same `applyMergeMarker` every other surface uses, so the audit comment, the hooks and the
  work-evidence gate on agent callers are unchanged; a viewer never sees either control.

  The counter was also discarding the claim once it was made. It required, on top of a deliberate
  stamp, a logged transition into `developed`/`testing`/`tested`/`released` — which work driven
  entirely by hand never has. Such an issue is now counted as shipped on the strength of the
  deliberate stamp alone. An auto-stamp written by the close itself still counts as no evidence,
  which is the ISS-817 property and is pinned against real Postgres rather than asserted.

  The path is drawn end to end in `docs/flows/issue-work-shipped-evidence.html`. (ISS-791)
- **An org admin can create a named agent, and that agent is a real member of the organization.**
  Until now every machine token borrowed a person: `job:<id>` was minted from `jobs.created_by`,
  `session:<id>` from `agent_sessions.user_id`, and a master agent — which has no `user_id` at all —
  had no valid principal to mint from, so `device.ownerId` was invented to stand in for one. The
  question *who made this write* had no true answer for the work agents do.

  `POST /api/orgs/:orgId/agents` (org `admin` and above) now creates a `users` row carrying
  `kind = 'agent'`, joins it to the org and to exactly one project, and mints its **Agent Access
  Token** through the same `mintPat` a person's PAT comes from. Same table, same middleware, and a
  permission path that does not differ by a line — an agent is authorized because it *is* a member,
  through `effectiveProjectRole` and the membership reads that were already there. `GET` lists them;
  `DELETE` retires one by revoking its tokens and dropping its memberships while keeping the row,
  because `activity_log.actor_id` points at it and a principal whose history vanishes on retirement
  answers the original question with nothing.

  An agent cannot sign in. `assertNotAgent` refuses `kind = 'agent'` at every entrance that mints a
  user JWT, and a test scans the source tree for callers of `signUserToken` and fails on one that
  does not refuse — the failure mode being guarded is not a broken entrance but a fourth entrance
  added later. Its address is random at `agents.forge.invalid`, a domain RFC 2606 reserves so no MX
  ever resolves it. It cannot mint another agent either: `/api/pat` and `/api/orgs` are both absent
  from `PAT_ALLOWED_PREFIXES`, so no PAT or AAT reaches either route.


- **Interventions performed by hand at the database are now counted, instead of being invisible to
  the number that exists to count them.** Forge's north-star metric is *interventions per issue
  closed*, and until now it could only see interventions that travelled through Forge: a cancel from
  the UI or MCP, a resume, an answer, a wedge notification. The one route operators actually reach
  for when a fleet is stuck — a `psql` session and an `UPDATE` — reached nothing that records
  anything. Two people cancelling two runs by hand moved the metric by zero, so the number fell
  while the work of running the system did not.

  The metric had also been *defined* by its own recorder — "wedge events plus audited manual
  cancels" — which is why the gap read as out of scope rather than as a gap. The definition now
  names the thing being measured (a human hand entering a run that was supposed to proceed without
  one) and lives in `docs/modules/control-observability/README.md` with the four sources that
  currently reach it and, just as explicitly, the ones they do not.

  A hand-written terminal flip on a job or a run is now recorded with the database role, the client
  application and both statuses, and shows up in the interventions view and the analytics endpoint
  as `direct_sql`, attributed to the issue it was performed on. **Manual SQL is not blocked, slowed
  or refused** — sometimes it is the only way to free a stuck fleet. It simply stops being
  invisible. Deliberately out of reach, because catching them would overcount ordinary work rather
  than count interventions: session-status writes, non-terminal flips such as a hand-written
  re-dispatch, and row deletion. (ISS-884)

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

- **Modules are visible, editable and filterable in the cloud UI.** The module taxonomy landed in
  the database and over REST in ISS-593, and no screen could see it: a project's parts existed and
  nobody could name one, attribute an issue to one, or ask which issues belonged to one. Three
  surfaces now do.

  **Project Settings → Modules** is the taxonomy itself: create, rename, recolour, describe,
  re-parent and delete. The hierarchy is an indented list with a parent picker per row rather than a
  drag-drop tree — the design system has no tree primitive, and the picker excludes each module's own
  descendants so the one refusal a reader could otherwise walk into is never offered. Delete asks
  first, and a module the server refuses to delete because issues still carry it says exactly that.

  **The issue detail** gains a Module row and a picker: one primary module and any number of
  secondary ones, saved as a single write. **The issues list** gains a Module filter — distinct from
  the label filter, because the server resolves the two against different rows — and a Module cell
  per row, with its own empty state naming the module rather than the generic "Nothing here".

  One server change was needed to make the cell possible: `GET /projects/:id/issues/search` joined no
  labels at all, so the list had no way to learn a row's modules short of a request per row.
  `?withModules=1` hydrates them in one grouped query, primary first, alongside the `withCost` /
  `withFailureInfo` / `withPipelineHealth` flags already there. (ISS-594)

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
  its own. Read it at `GET /api/memory/revisions?projectId=…&sourceRef=…` — the MCP tool that also
  served it is removed in this same release, see below.
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

- An issue whose next step is queued now says so — on its own page and on the board: which step,
  what is holding it, how long it has waited, and when it will try again. Before, a queued step
  looked exactly like an issue nobody was working: the pipeline panel had no queued arm at all, and
  the card and the list row took their reading from the run's status rather than from the gate
  actually holding the step. `pipelineHealth` carries a `queuedStep`, the issues search endpoint
  serves it under `withPipelineHealth=1` — which the board and the list both already send — and the
  blocker banner takes its tone from whether the wait needs anyone to act, so waiting on a
  dependency reads as information rather than as an alarm. Shipped 2026-09-03; this line was owed
  then and is written now. (ISS-903)

- **The interventions metric — the north star — could be read from a browser session and from
  nothing else.** `GET /api/pipeline/interventions` is a cross-project fan-out: with `projectId`
  omitted it answers over every project the caller can see, so `/api/pipeline` is off
  `PAT_ALLOWED_PREFIXES` and a personal access token is refused on the path before the query string
  is ever read. Adding `?projectId=` did not change that and was never going to — the allowlist
  judges the route, and a fence that switched on an optional parameter would be a fence the caller
  decides. `GET /api/projects/:id/metrics/interventions` is the project-scoped half, the fourth of
  a pattern `step-durations`, `retry-rescues` and `session-failures` already follow, and it is
  fenced by the token's own project allowlist: a token naming a project it may not see gets
  `project not found`, not that project's rows. The rollup both routes answer from now lives once,
  in `metrics/interventions-report.ts`. No MCP tool was added — that surface is under a documented
  shrink and `forge_metrics.*` is in its "free to go" group. (ISS-944)

### Removed

- **Forge no longer issues a separate credential for each job and each unattended session. A paired
  box holds one credential, and that is what its agents use.** Until now a dispatched job was handed
  a token minted for that job alone, and an unattended chat or schedule session got one of its own;
  both were created under the account of a *person* — whoever filed the work, or whoever owned the
  session — and Forge told an agent's writes apart from a person's by reading the token's NAME.
  That is gone. An agent is now an account in its own right, so "was a person or an agent at the
  keyboard" is answered by who owns the credential rather than by what it is called.

  **What you will see.** Work an agent does shows under the agent's own name, and you can revoke it
  or move it between projects the way you would any other member. A token you create by hand and
  happen to name `job:something` is now an ordinary token: naming it that no longer grants anything,
  and it no longer counts differently against your token limit — only credentials issued to a paired
  box are excluded from that limit now.

  **What an operator must do.** Each box needs an agent account of its own before its work reports
  under one, and each project that box serves needs the agent that speaks for it. Until a box is
  re-paired that way, its writes are recorded as its human owner's and the evidence checks that
  apply to agents will not apply to them. Pairing is the whole of the change — no token you hold
  stops working.

  **One case now refuses instead of guessing.** When a single box is running two sessions for the
  same project at once, a tool that files a finding or a report against "the work I am doing" can no
  longer tell which one, and says so instead of picking. Before, it picked the most recently started
  one and was quietly wrong some of the time.

- **`print` mode. Every agent a runner starts is now one long-lived session that reads its turns
  off stdin, and there is no longer a mode to choose.** A runner used to spawn `claude -p "<prompt>"`
  with stdin closed, read stdout to the first result, and let the process die — one prompt, one
  process, one unit of work. Three things followed from that identity, and all three are what this
  removes: a driver that had to ask a human parked the issue and its session was *gone* (measured
  2026-08-27: `needs_info` parks sat a 360h median, with **zero** human replies across all 17 of
  them); nothing could be told to a running agent, so every correction was a new process with a cold
  context; and every counter that said "turn" actually counted processes, because the two were the
  same number.

  A session now survives the turn that started it. It can be asked a question, answered, injected
  into, checkpointed and closed without losing the work in flight — a human's comment on a parked
  question is delivered into the living session, which picks the work back up with its context
  intact instead of a fresh agent re-reading the issue from scratch.

  `pipelineConfig.sessionMode` is deleted, and `0214_duplex_strips_session_mode.sql` strips the key
  from stored configs before it leaves the schema. **That migration refuses to run if any project
  explicitly opted out of duplex**, naming them, rather than quietly moving the one project that
  said "not this lane" onto that lane. Nothing opts out today; the guard is for the window.

  *Technical: the deletion is the second half of ISS-873, whose phases 0–4 shipped 2026-08-29. What
  it removes from the runner is `JobSpec::duplex` and every branch that read it — the `Stdio::null()`
  stdin, the `-p` argument, the conditional input format, and the reader's print-only break on a
  send error — plus `session_mode` from the two claim types. Core keeps sending `sessionMode:
  "duplex"` as a constant, recorded as `cm:hack ISS-941`: a core deploy reaches every box at once
  while a runner binary reaches one on its own 6-hour update check, so dropping the field before the
  fleet converges would make every un-upgraded box read it absent and run a print lane this release
  no longer has — a silent fleet-wide revert. Three items on the issue's own delete list were
  refused and each says why in `docs/flows/agent-execution-session-turns.html`: the 25s heartbeat
  beat, `RESULT_EXIT_GRACE` and the job-level outcome derivation are shared machinery the issue
  attributed to the mode, and the last of them is the only thing that reports a job which exits
  immediately after its final result. The flip to duplex-by-default was taken on a 7-day
  measurement rather than on more code — no duplex-specific failure cause on either project with
  volume, and a print cohort that does no work at all, so the comparison the gate asked for was
  never going to arrive. Four superseded design documents were deleted rather than corrected.
  (ISS-873)*

- **The `forge_memory.revisions` MCP tool.** The MCP surface is being shrunk to the
  session-lifecycle group (ISS-894). It has **no rows at all** in `mcp_audit_log` under either
  spelling — the first registered tool measured at zero calls lifetime — no `skills.skill_md` row
  on the live instance names it, and `GET /api/memory/revisions` answers a job-scoped PAT. The
  registry goes 60 → 59. `runMemoryRevisions` and the REST route are untouched; only the second
  way in is gone.

  **The deletion rule's second clause was not met, and the rule now says why that is allowed
  here.** It asks that the replacement route accept a device token; `GET /api/memory/revisions` is
  `requireAuth()` and would refuse one, the same shape that made `/api/skill-facts` a bad
  replacement for `forge_skill_facts.get`. The difference is that tool had 23 device callers to
  strand and this one has none. `docs/architecture/agent-surface.md` now states that reading and
  prices it: available once per tool, on evidence of zero rows whole-table under both spellings,
  worth nothing for a tool with traffic, and revoked if a device caller for a tool deleted this way
  ever appears.

  The wave that measured this before reported "no candidates" because it joined the registry
  against the audit log with an inner join, and a tool nobody has ever called has no row to join
  to. That clause is now part of the deletion rule in `docs/architecture/agent-surface.md`, which
  is also corrected where it named the `forge-plugin` CLI as what pins the remaining tools: ISS-508
  moved that CLI to `/api` on 2026-09-06, and what holds the surface open now is
  `packages/runner/.../mcp/config.rs` writing the box's device token into every agent session's
  `.mcp.json` (ISS-931).

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

- **A run pane that has finished is now ended, instead of being held open for the life of the
  box.** A master pane is briefed again every sweep, so an idle one is between passes; a run pane
  is briefed once and has nothing left to do after its last turn. Nothing modelled that difference.
  The heartbeat asserts "this box still holds this run" and never progress, so a finished run pane
  was beaten every thirty seconds, core's ten-minute reaper never fired over it, and the worktree
  and leases it held stayed held by derivation — with `pool load` reporting `jobsRunning: 0` the
  whole time, because that counter counts jobs and a run session is a pane and a checkout with no
  `jobs` row. Measured on forge-vm 2026-09-12: 32 of 34 run panes idle, the oldest 22 hours,
  sidpeak holding 20 slots and 19 checkouts against a budget of three, its master reporting "four
  working against a budget of three" while two issues waited on nothing but capacity. The sweep now
  reads what each session reported of itself and ends a run that has been idle past
  `RUN_IDLE_BEFORE_EXIT` rather than beating it; the close loop it already had takes over from
  there. **Silence is not idleness** — a session that has never reported keeps being beaten, so a
  pane whose hooks failed to install is not mistaken for a finished one — and a run stopped on a
  question a human owes outlives the window, because that question is answered on human time.

- **A run pane's hooks were installed, fired, and were discarded for having no identity to report
  under.** `run_session::start` wrote the hook settings into every run's worktree and logged
  `hooks registered`, but the pane was opened with the bare pane environment, so
  `forge-runner hook` found no capability and returned without reporting — by its own design, which
  is to never fail the agent that ran it. Every run pane on every box therefore reported nothing
  for its whole life, and the channel built to tell a finished session from a working one carried
  only master panes. The run's session id now travels with the spawn and its capability is minted
  on the daemon's side of the port, the way the master path already did it; a mint that fails
  refuses the spawn rather than opening a pane nothing can ever decide is finished.

- **Answering a decision can no longer overwrite an answer that was already there, revive one that
  was withdrawn, or apply to a round you were never shown.** The write that recorded an answer
  checked only that the option belonged to the question's latest round, then wrote unconditionally:
  two people answering at once left the second one's choice on the record with no sign the first
  had ever happened, a question somebody had deliberately withdrawn came back as live and the run
  acted on it, and an expired one did the same. It is now a single locked write — status, deadline,
  round, option and authority are all checked against the same locked row, exactly one answer wins,
  and the losers are told why in words rather than being discarded quietly. An answer now carries
  the round it was shown on, so a decision that moved on while your screen was open is refused as
  stale instead of silently settling the newer question. The run is told only once the answer is
  durable.

- **A signed-in person who belongs to neither a project nor its organisation could read that
  project's parked decisions, and answer them.** The check that decided who may look asked whether
  any access record existed rather than whether the person held a role, and the check that decided
  who may choose asked only that they were not a viewer — so someone with no relationship to a
  project at all passed both. They now see nothing and can choose nothing.

- **An issue whose run died mid-build is picked up again instead of sitting there for ever.** While
  an issue is being built it holds a status only the run building it can move it off — it is
  deliberately not offered to any box's backlog, because a run already has it. The recovery pass for
  that status asked for two things that are only true when the agent finished tidily: that its last
  piece of work ended cleanly, and that its run was still open. A run that DIED satisfies neither,
  so the issue it was building stayed where it was, offered to nobody, with nothing in the system
  ever looking at it again. Measured on one project on 2026-09-11: eleven issues stranded that way,
  the oldest for eight days, seven of them holding work already pushed to a branch. The pass now
  also recognises the shape where the run itself has ended, whatever its last piece of work
  reported — and two things it refuses are unchanged or newly explicit: an issue somebody has paused
  stays paused, and an issue whose work already shipped is never re-dispatched into live code but
  reported for a human to close.

- **Two more ways a finished run could hold its checkout for ever.** Both ended the same way — the
  release was refused, so the run never reached terminal, so the issue stayed unavailable to every
  box — and both were found on one box the day the first of these fixes let it drain. The first: the
  checkout was removed by a path rebuilt from the branch name, which is right only while the two
  agree. Three runs had a checkout under one name carrying a branch under another, and git answered
  that the path was not a working tree. The path the run actually recorded is used now. The second:
  the salvage step answers "nothing" both when it could not preserve a diff and when there was no
  diff to preserve, and the second was being read as the first. Six runs were clean checkouts
  carrying commits of their own, refused release on the grounds that a diff nobody had was not
  saved. Removing a checkout leaves the branch and its commits in the repository, so a clean one is
  safe to release whatever salvage made of it — the refusal now asks that checkout directly whether
  it still holds uncommitted work, and stands whenever it does.

- **A checkout whose work is already on the remote is released instead of held forever.** The one
  reader that decides whether a worktree still holds something took a missing upstream as proof
  that its commits existed nowhere else. A branch cut for a run has no upstream until it is pushed,
  while sitting on exactly the commit the remote already carries — so a clean checkout was judged
  to be holding work, the salvage step then found nothing to preserve, and releasing it was refused
  as a disagreement between the two. Permanently: the checkout stayed, the run could never reach
  terminal, and the issue stayed unavailable to every other box. Measured on one box on 2026-09-11,
  thirty runs were stuck that way, each holding a checkout whose tree was clean and whose HEAD was
  on `origin/main`. The question is now asked of the remote directly — whether any remote branch
  already contains this commit — so a branch with genuinely local-only commits is still held, and
  a repository with no remote at all is held too, because nothing there can prove a copy exists.
  One consequence is worth stating: a checkout holding ONLY files the agent never added to git is
  released without those files being committed first. That was already true of every pushed branch
  and is the same rule the sweep has always applied — untracked files do not protect a checkout, or
  build output would pin every one of them forever — but it now applies to unpushed branches as
  well.

- **Updating the runner no longer kills every agent on the box.** Agent sessions live in a
  terminal server the runner used to start as a child of its own service, so stopping the service
  — an update, a restart, a crash — took the server down and every agent with it. That is why an
  ordinary version bump had to be scheduled around running work, and why a box that restarted under
  load woke up with dozens of dead sessions still holding their checkouts. The session server now
  runs under a unit of its own and survives a restart of the runner, which reattaches to the
  sessions that were already there. Two things fall out of the same change: the server is on a
  socket of its own, so it no longer shares one with whatever terminals the person logged into the
  box is running — until now, their `tmux kill-server`, or simply their last window closing, could
  end every agent on the machine — and a box that cannot give the server its own unit (macOS, a
  container) says so by name and keeps working exactly as before. Sessions left on the old shared
  server are reclaimed the way any unreachable session is: their work is pushed to a branch first,
  then the checkout is released.

- **A run whose agent died without shutting down no longer holds its checkout and its issue
  forever.** Recovery could see everything it needed — the process gone, the session terminal — and
  still had no way to act on it: a run only reaches terminal after its worktree is observed off the
  disk, the only thing that removes a worktree is the reaper, and the reaper refuses every tree
  whose run has not reached terminal. Nothing on the box could break that circle, so a box that
  restarted under running work accumulated dead runs that each held a checkout and kept their
  issues leased, until the pool had nothing left to offer and no master could pick anything up.
  Recovery now hands the tree back itself, pushing whatever the agent had got to before releasing
  anything, and refuses to release a tree whose work could not be preserved. Measured on the
  maintainer's box the day this shipped: 24 dead runs, 24 held checkouts, every issue under them
  unclaimable. A run whose own process still answers, a run recorded before the last reboot, and a
  run parked on a human question are all left exactly as they were.
- **A box no longer restarts itself through work it is doing.** When a runner picks up its own
  update it is supposed to wait for in-flight work to finish before restarting. It waited on a
  counter that agent runs never touched — the counter tracks pipeline jobs and chat turns, and a
  run session is a terminal and a working copy with no job row at all — so the wait ended
  instantly and the restart took the terminal server, and every session on the box with it.
  Measured on forge-vm 2026-09-09 at 23:07:53: the wait reported the box idle **0.7 milliseconds**
  after the new binary landed, while 26 sessions were running, and **22 sessions across 5 projects
  ended as unreachable**. The wait now also counts the box's own record of what it is running, so a
  full box defers its restart to the next quiet window instead of ending the work. A session parked
  on a person's answer still does not hold it back — that wait has no time limit and would pin the
  box on an old build forever. The ceiling on how long a restart will wait was also raised from 30
  minutes to two hours, measured rather than guessed: of 879 sessions that completed since
  2026-09-01, half finish inside a minute but a tenth run longer than 45 minutes, so the old
  ceiling gave up on a tenth of all work by construction.

- **A run whose own agent died no longer reports itself as alive forever, holding the issues it was
  given.** A box tells the control plane which runs it still holds, and it decided that by asking
  whether the *supervising* agent was still there — never whether the run itself was. Registering a
  supervisor re-finds an existing registration rather than minting a new one, so its identity
  survives being killed and restarted; after any such restart the box went on vouching for every run
  whose own pane had died in the same moment. Nothing else closes those: the central sweep only
  reaps a run that has gone silent, and this one was not silent. Each of them kept holding the
  issues it had claimed, so a project could read as having nothing to run while showing nothing
  running. Measured on forge-vm 2026-09-09: **19 of 22 open runs were dead and still reporting, 24
  issues held across 5 projects**. The box now asks the operating system about the run's own process
  and gives back the ones that are gone, while a run merely waiting on a person — which has no
  process by design — is still preserved, tested in both directions.

- **Two issues with the same number in different projects can no longer end up in one working
  copy.** A run's terminal is named after its branch, which is unique per project, while terminal
  names are unique per *box* — so a second project's `ISS-368` resolved to the first one's terminal.
  The spawn helper would silently attach to the existing one and report its process as the new
  run's, putting an agent to work in another project's checkout with no error anywhere. The name is
  now checked before anything is recorded, created or started, and a collision is refused by name,
  the same way a working copy another live run holds already was. Two same-numbered issues still
  cannot run on one box concurrently; the second is now told so instead of quietly joining the
  first.

- **A project's dashboard no longer says it has no runners while one is running its work.** The
  Runners card counted the boxes *you* had paired, not the boxes bound to the project, so a runner
  somebody else set up was invisible: a project with an online machine executing an issue read
  "No runners paired yet · 0/0 online". It was not an empty list but a false claim, and the same
  page's Sessions tab showed the machine busy at the same moment, because that surface had always
  asked the project. The card now asks the project too, so who paired a box no longer decides
  whether you can see it.

- **A parked issue now says what it is waiting for.** An issue held for a person carries which kind
  of answer it needs — a decision or a resource — and the API that agents and the board read never
  returned that field, so every park read back as "waiting" with no hint of what would end it. The
  value was being stored correctly the whole time; nothing could see it.

- **A Windows-only break can no longer merge green.** The Rust runner's three-platform check lived
  in a workflow of its own, and GitHub cannot make one workflow gate another — so the merge gate was
  measuring Linux alone. On 2026-09-09 the Windows leg went red while the gate went green and the
  merge went through. The three platforms now run inside the gate itself, and the duplicate workflow
  is gone rather than left beside it.

- **A run session no longer starts, reports itself healthy, and does nothing.** The brief that tells
  a run pane which issues it carries was pasted the instant the pane was spawned, and Claude Code
  draws its composer a second or two after startup — a paste that lands first goes to the terminal as
  raw text and the Enter that follows submits nothing. There is no error on any path: the pane is
  alive, the brief is on screen, and no turn has run. The master path already slept five seconds for
  exactly this reason and said so in a `cm:guard`; the run path, added later, pasted immediately. Both
  now go through one `terminal::brief_new_pane`, and a test fails the run path if it reaches for the
  bare send again. Measured on forge-vm 2026-09-09 under sixteen concurrent panes: 6 of 16 runs had
  spent **$0.00** after six hours, including all four of sidpeak's, which is why that project looked
  idle while its master claimed correctly and its runs beat on schedule. It is a race, not a
  certainty — the ten panes on a small repo won it and every pane on a multi-gigabyte worktree lost —
  so a blind wait is a floor rather than a proof, and a pane that has run no turn after a couple of
  minutes is still worth checking for.

- **A machine no longer spends an agent pass every 30 seconds to be told the same thing.** The
  daemon nudged each project's resident master on every sweep whenever anything sat in its pool,
  and one nudge is one full agent pass. When nothing was claimable — every runner on the box
  rate-limited, say — that produced a pass a minute per project whose only output was to repeat
  why it could not act. Measured on one box: 1,354 nudges over 95 minutes, 0 claims, $245. A
  master is now told when the work in front of it actually changes, identified by job and issue
  id rather than by titles or priorities that move without the decision moving. Unchanged work
  still reaches it every five minutes, so a pass lost to a stuck pane or a limit lifted out of
  band is still retried with nobody watching — the period is a ceiling on silence, not permission
  to stop.

- **A master is offered your issues again after a run was cancelled.** An issue only reached the
  new event-driven backlog if no job row had *ever* been created for it, so any issue whose earlier
  run was cancelled or failed carried a finished row that hid it for good — and every project that
  ran under the previous dispatcher had such a row on nearly every issue it had touched. Measured
  right after the change went live: zero admissible issues across all 25 projects one box serves,
  with the only work left in its pool being two job rows the old dispatcher had already minted. The
  check now asks whether work is open on the issue *now*, so a finished job is history rather than a
  lock; a `held` job still withholds the issue, because a session owns it, and an issue whose run is
  still open stays withheld as before.

- **An issue you paused on purpose no longer says a human is needed.** Three statuses used to share
  one word on the dashboard: `needs_info`, where an agent asked you something; `waiting`, where the
  work is blocked on a decision or a resource only you can supply; and `on_hold`, where somebody
  deliberately pressed pause. Only the first two are a question. `on_hold` now reads **Paused** on
  the board, in the rail and on the issue header, and it no longer appears in the Awaiting-input
  list on your Attention inbox. This matters more than it sounds: stopping a duplicate pipeline run
  parks its issue by default, so the inbox grew one "needs a human" row per cancellation and none of
  them wanted anything — which teaches you to skim past the rows that do. The Blocked tab on the
  issues list also gained `waiting`, a real question it had been leaving out while carrying pauses,
  and `waiting` left the Active tab, so no status now sits in two tabs at once. Nothing about what
  `on_hold` *means* changed, and no status was added: the three surfaces that each kept their own
  list of "parked" statuses now read one shared map, held together by a test that fails when either
  side is edited alone. Drawn in `docs/flows/human-routing-attention-claim.html`.

- **A paused issue's own page reads calm now, instead of amber.** The banner at the top of an issue
  somebody put on hold still offers **Resume**, but it no longer wears the colour this app reserves
  for something a person has to clear — and it says an operator *can* resume it when the work is
  wanted again, rather than that one *must*. The banners for the two statuses that really are
  waiting on you, "Needs a human" and "Waiting", are unchanged.

- **Prose a model wrote is refused before core stores it when it carries a script the model's own
  input never used.** `memory/extraction.ts` and `memory/consolidation.ts` are the only two places
  this repo stores LLM-composed text — extracted facts and `knowledge_edges`, consolidated and
  rewritten memories, and the evidence on a reconcile archive — and all three prompts instruct the
  model to *preserve the original language*. Nothing checked a character, which is how the Cyrillic
  for "bypass" reached an otherwise-Vietnamese acceptance criterion on another project (ISS-962).
  The new `memory/script-guard.ts` answers `foreignScriptChars(rendered, source)`: Latin, Common and
  Inherited are always storable — that is ASCII, precomposed Vietnamese, digits, punctuation, emoji
  and the combining marks an NFD spelling decomposes into — and anything else is storable only if
  that exact character occurs in the source. A failing item is dropped unstored, logged with its
  offending code points, and counted on the run's new `refused` field, so a drop is visible rather
  than silent. Extraction computes the allowance from the human signal alone (issue title and
  comments, never the existing-memories block in the same prompt), because licensing off already-stored
  model output lets one leaked character license the next; consolidation and reconcile, which only
  rewrite what is stored, use their whole prompt. Drawn in
  `docs/flows/knowledge-memory-model-prose.html`. **Core still renders no Vietnamese** — the tracker's
  prose pipeline and its `.vi-glossary.json` handling are `forge-plugin`'s and are reported there.
- **A GitHub repository bound to an existing App connection was deaf to every webhook.**
  `POST /api/integration-connections/:id/bindings` minted a `whsec_` secret of its own, while
  `handleInbound` verifies deliveries against that same field and GitHub signs with the webhook
  secret it generated when the App was created. Every delivery therefore failed signature
  verification, with no delivery row and nothing on screen — the hub rendered the integration as
  configured. The bind path now carries the App's own secret, as the manifest flow already did; only
  providers that sign with a Forge-minted secret still get one.

- **The git-credential mint named a repository by the spelling git asked with.** GitHub folds
  repository case, so a fetch of `sidcorp-co/EPODSYSTEM_CLI` was resolved correctly and then logged
  under a name that matches no repository on GitHub. The binding's spelling is now what the grant
  and every refusal report.


- **`pg-boss` is pinned back to 10, because 12 cannot start against the schema this project's
  databases hold.** The Dependabot majors group (#317) took it from `10.4.2` to `12.30.0`. Every
  gate passed — 15 conformance checks, 5,825 unit tests, 1,167 integration tests, the build, CI on
  two PRs — and the deploy that carried it took the staging API down for 40 minutes: `boss.start()`
  aborts with *"Cannot migrate pg-boss schema from version 24: the oldest supported starting
  version is 25"*, before the server listens, so the proxy answered `no available server` on every
  route including `/health`.

  No suite could have caught it: they all build a fresh schema, where pg-boss installs its own
  tables at whatever version the installed release wants. The failing state — an existing schema at
  24 — exists only in a deployed environment.

  The other sixteen updates in that group stand. **The price:** the queue is two majors behind and
  the same bump will be re-proposed and pass the same gates. Adopting 12 needs two API deploys in
  sequence (11 to move the schema to 25, then 12), which is a decision about a shared environment
  rather than a diff — `docs/proposals/pg-boss-12-upgrade.md` carries it.

- **A character entity written in an issue or comment body is no longer escaped a second time on
  every save.** The component parser decoded entities in attributes but not in prose, while the
  serializer escaped both — so a body containing `&quot;` was stored as `&amp;quot;`, rendered as
  the literal text `&quot;`, and grew one `amp;` for each re-save. `forge_comments.update`
  re-saves, so an edited body degraded further every time it was corrected.

  `normalize.ts` has always declared itself idempotent and the test asserting it used an
  entity-free body, which is the one shape that cannot see the defect. A non-raw text node now
  holds decoded characters, the projection every prompt, embedding and MCP serializer reads
  returns the character rather than the entity, and the idempotence test carries the entity case.
  Markdown bodies are a passthrough that is never parsed, so only the five `html` rows written
  since 2026-09-03 were affected and none needed a backfill.

- **A dependency cycle can now be undone, and a retracted edge stops blocking the next one.** Two
  defects on the same write path, each on its own falsified test. First: the cycle check ran on
  every `blocks` write including the one that retires an edge, so re-sending an edge with
  `validUntil` in the past — the only retraction an agent has, since `DELETE` is JWT-only REST —
  was refused with `CYCLE_DETECTED` for the very loop it would have opened. A cycle that existed
  had no exit through the API at all; on the ISS-933/ISS-964 pair the workaround was to expire the
  other edge first, which only works while exactly two edges form the loop. The check is now
  skipped when the write's `validUntil` is already past, and only then: an edge with a FUTURE
  expiry that closes a loop is still refused, which is the second of the two new cases. Second:
  `detectCycle` walked expired edges, so a retracted edge went on refusing new ones forever even
  though the dispatcher had already stopped reading it. Both walk cases and both write cases were
  watched red against the unfixed source, each naming its own rule.

- **A typed record of any block count now lands in one comment write.** A comment body was capped
  at 10,000 characters, and the plugin's issue-flow contract posts every typed record — plan,
  confirmation, review, verdict, verification — as a comment, because a comment is the only
  per-issue write the API offers. A verdict record carries one block per acceptance criterion, so
  a thirty-four-criterion verdict measured about forty-eight thousand characters and was refused
  outright — after the evidence uploads, which cannot be undone. The client's answer was to split
  one record across five comments, which lands but makes the record five things to read back and
  re-assemble.

  The cap is now 64,000 characters at all three doors — `POST /api/issues/:id/comments`,
  `PATCH /api/comments/:id` and `forge_comments action=create|update`. It is one number for every
  body rather than a tier per record kind, and that is the point: a cap that differs by kind
  cannot be written as the single `maxLength` a client reads out of the tool's `inputSchema`, and
  a client that must first learn which tier it is in cannot refuse locally before it uploads. The
  number is now published on `data.body.maxLength`, so a client refuses before sending rather
  than after.

  No migration: `comments.body` is Postgres `text`, so the 10,000 was only ever a validator. The
  MCP page budget stays 38,000 — the cap bounds one comment, the budget bounds one page, and the
  one-row floor between them is what lets a 64,000-character record come back whole in a page of
  its own.

- **Every step-handoff payload the prompt asks for now validates.** `prompt/facts/registry.ts`'s
  `HANDOFF_KEYS` named each step's own fields and omitted the two that every branch of
  `stepHandoffSchema` keys on as `z.literal` — `step` and `schema_version` — for all eight step
  types at once. An agent that sent exactly what the prompt listed got a `400 Invalid input`, and
  the `cm:edge lockstep` on that map exists to catch precisely this drift but could not: it fires
  when one half moves, and the field had been missing from both halves' agreement since the map was
  written. Measured on `drive`, where the handoff is the only record a human reads of the turn.

  The two fields are now named once in the renderer rather than copied into eight lists, so the
  next step type added cannot omit them, and `registry.test.ts` asserts the parity by reading the
  required literals off `stepHandoffSchema` itself — a list spelled twice would pass while the two
  modules disagreed. `mcp/tools/forge-step-handoff.ts`'s docblock said agents "never specify the
  discriminator"; only `kind='handoff'` was ever hardcoded for them.
- **A comment thread is now readable to its end by a client with no browser.**
  `GET /api/issues/:id/comments` answered the whole tree under a fixed 1,000-row cap and said so —
  `hasMore: true`, `truncatedBy: "response-size"`, and a notice whose remedy was *"a higher limit
  will NOT help — read the full thread in the UI"*. That was accurate and left a CLI caller with no
  move at all: the forge-plugin CLI met the bound on every long issue and broke in five places at
  once, including a status judged off the whole record refusing every operation on a long issue
  because it could not read the record whole. Both surfaces now take a cursor — REST `?cursor=`,
  MCP `forge_comments {cursor}` — and answer `nextCursor` under the same name and meaning, from one
  codec, so a token either transport mints decodes in the other. The size budget still bounds one
  page; nothing bounds the thread.

  Three things this change had to get right, each of which fails as a *clean* walk over an
  incomplete thread. The cursor walks **root** comments, not comments: `buildCommentTree`
  deliberately drops a reply whose parent is off-page rather than promoting it, so roots are the
  only row set for which the tree builder is correct on a partial fetch. The token carries the DB's
  own microsecond rendering of `created_at` rather than a JS `Date` — a `Date` holds milliseconds,
  and a token minted from one names an instant at or before its own row, which made every page
  repeat its predecessor's last root (measured: 47 rows read off a 40-comment thread at limit 7).
  And `hasMore` is `nextCursor !== null` and nothing else, because `total` counts every comment flat
  while a page carries roots, so `returned < total` stays true on a thread already walked to its
  end. On the MCP side the size trim now sheds whole subtrees from the newest end and keeps at least
  one row: an empty page under a cursor is a dead end, and a 20K-character agent report over the
  budget is ordinary. `lib/pagination.ts` gains `cursorList`, the third of the three REST list
  shapes — its own "two shapes and no third" rule (ISS-889) is rewritten here, because a keyset
  route can honestly state neither an `offset` nor a `hasMore` computed off a count. The walk, its
  three bounds and every way it ends early are drawn in
  `docs/flows/issue-work-comment-thread-read.html`. The plugin's own client half is its issue,
  there. (ISS-956)

- **A `waitingKind` is now refused on every target that cannot store it, instead of being accepted
  and nulled.** `POST /api/issues/:id/transition` and `forge_issues action=transition` advertise
  `waitingKind` for any `toStatus`, but the write stores it only for `toStatus === 'waiting'` and
  `transition-reason.ts`'s `needs_info` heading ignores the argument it is handed. So a kind sent
  with any other target reached no reader anywhere: not the row, not the comment, not the health
  surface — and the call reported success, leaving a caller unable to tell a stored park from a
  dropped one. Measured on 2026-09-07 across sixteen `needs_info` parks made in one pass, each
  carrying `waitingKind: "needs_decision"`; every write succeeded and not one kind survived.

  It now throws `WAITING_KIND_NOT_APPLICABLE` (422 on REST, `waiting_kind_not_applicable` as a
  batch skip reason), keyed on the **requested** status and placed outside the
  `requiresAuthoredReason` block. Both placements are load-bearing: an agent's `waiting` stays legal
  on an autonomous project, where the park rewrite lands the row on `needs_info` and the kind still
  reaches the reason comment's heading, while `in_progress` — a target that demands no reason at
  all — was the commonest silent drop and a check nested in that block would have passed it
  straight through. The driver's own fact text and the lifecycle guide now name the refusal by
  code, so an agent is not told one thing and refused another.

  Scope note, because this issue was filed claiming more: a park's `reason` was never lost.
  `postTransitionReasonComment` posts it as a comment inside the same transaction as the status
  write, and `REASON_REQUIRED_STATUSES` makes it mandatory for `reopen`, `waiting` and
  `needs_info`. Nor is an edge's `reason` discarded — `issue_dependencies.reason` stores it and
  `GET /api/issues/:id/dependencies` returns it; the agent-facing relations digest omits it
  deliberately, because that payload is inlined into an agent's context without the untrusted-data
  framing `serialize()` applies. The original report mistook the absence of a field on the issue
  *document* for the absence of the value.


- **A token shared by a dispatcher and the agents it runs is rate-limited for that load, and a
  refusal now says exactly how long to wait.** The `forge` CLI's credential file is per-user, so on
  a box running a dispatching session plus four to six agents, one PAT carries every issue read,
  comment list and knowledge search all of them make. That was one bucket of 600 requests a minute,
  and under a wave it was ordinary reads that exhausted it: a single `forge next --why` on
  2026-09-07 was answered with twelve rate-limit waits, and the CLI's filing gate — registered with
  a ten-second budget — printed `waiting 19s` and took twenty, so the gate failed open.

  The per-token bucket is now **two** buckets, reads counted apart from writes, so a wave's reads
  can no longer spend the budget its writes then queue behind. Reads get 2400 a minute, which is
  eight sessions at three hundred each rather than a round number: 108 calls in a minute is the
  measured peak of ONE busy session (30 days of `mcp_audit_log`, ISS-894), a dispatcher plus its
  agents is eight of them, and `forge next --why` fans out over every open issue in one command, so
  the per-session figure is above the steady peak on purpose. Writes keep 600 — six times that same
  measurement — because writes were never what starved.

  Which bucket a request charges is decided where the answer is knowable: REST reads it off the HTTP
  method, and `/mcp` — where every call is a `POST` and the method says nothing — off the JSON-RPC
  envelope, from a clone of the body so the transport still gets its stream. An unrecognised tool,
  an unparseable body and an unknown method all charge the *write* budget, the stricter of the two,
  so a tool registered next release keeps exactly the ceiling it has today rather than escaping the
  limiter.

  Which verbs count as reads is judged by what the handler does, not by how the verb reads. Review
  caught `fetch` in that set on the strength of its name: its only consumer, `forge_uploads
  action=fetch`, calls `assertPrincipalIsWriter` and inserts a `download_tickets` row on every
  call, so a writer-gated mutation was being charged the larger read budget. It is out, and the
  test that pins it out asserts the consumer's authz rather than the spelling. The same pass added
  the member-gated reads that were being charged the smaller budget for no reason —
  `forge_issues action=listTasks` and `forge_coolify_deploy`'s `status`, `logs`, `runtime-logs`,
  `applications`, `targets` and `rollback-images`, which is exactly the poll-heavy traffic this
  issue was filed over.

  A `429` was already carrying `Retry-After`, and the CLI was already honouring it; what it could not
  say was whether to stop at all. The body's `details` now names the window, the ceiling, the
  remaining budget and **which class was refused**, and `X-RateLimit-Reset` and `X-RateLimit-Scope`
  ride on every response — so a client whose reads are exhausted can see that its writes are not.

  `RATE_LIMIT_PAT_MAX` and `RATE_LIMIT_PAT_WINDOW_MS` are **retired**, and core refuses to boot
  while either is set, naming both replacements. There is no single value left for the old name to
  mean, and a schema that simply stops reading a key an operator deliberately lowered would leave
  that number silently unenforced. The four replacements
  (`RATE_LIMIT_PAT_{READ,WRITE}_{MAX,WINDOW_MS}`) are declared with `${VAR}` lines in
  `docker-compose.prod.yml` and in both `.env.example` files, which is the whole point of the
  `8ff505af` fix they inherit. A token's own `rate_limit_max` column, where set, now caps each class
  rather than the two together — the three credentials that pin one (a paired box, a `job:` token, a
  `session:` token) are single-session tokens whose 600 was sized as six times that session's peak,
  and that intent is per axis. Flow: `docs/flows/organization-access-token-throttle.html` (ISS-961).

- **A `decomposes` edge no longer waives the work-evidence gate in silence.**
  `pipeline/work-evidence.ts#hasChildIssues` read exactly one dependency kind — `decomposes` — and
  a single live edge made `findMissingWorkEvidence` return `null`, which is the whole of ISS-786's
  anti-fabrication gate: an issue with one decompose child could be marked merged and moved to
  `developed`/`testing` with no branch, no commit and no code handoff. Three agent-facing documents
  said the kind was inert (`guides/registry.ts`: "it holds nothing back"; `prompt/facts/registry.ts`:
  "it gates nothing"; the `set_dependency` tool: "no lifecycle of its own"), so an agent wired a
  decompose believing the write was a grouping label and removed the check that catches a fabricated
  merge. Nobody was lying: the record was made, and what the edge actually did was in no document.

  The waiver stays — it is ISS-786's deliberate grouping-parent exemption, and removing it would
  refuse every epic whose children carry the code. What changed is that nothing can claim otherwise.
  `issues/dependency-effects.ts` now holds `WORK_EVIDENCE_WAIVER_KIND` (the one kind the query
  filters on) and `WORK_EVIDENCE_WAIVER_NOTE` (the sentence the surfaces render). The four `.ts`
  surfaces interpolate the note, so they cannot drift; `db/schema.ts`'s `cm:guard` and
  `docs/modules/issue-work/README.md` cannot, and `dependency-effects.test.ts` holds those two by
  reading their source — proven red under a planted change of the kind. `setIssueDependency` now
  returns `effects { gatesDispatch, waivesWorkEvidence, note }` on every outcome, including the
  idempotent re-assert, so the write that creates the edge reports the effect it just had.

- **`check-flow-coverage` no longer calls a function-hit "settled end-to-end".** The summary read
  `N step(s) across M flow(s), K settled end-to-end` and marked each row `e2e`, while the whole of
  the verdict was `entry.f[id] > 0` — istanbul's per-function *invocation count*. Any call that
  entered the annotated function settled the step, whatever it then did: `release/deploy` was
  settled by three cases, one of which is `tryDispatchCoolifyRelease`'s early return for a project
  with no Coolify binding, which touches no deploy and enqueues nothing. Readers took "settled
  end-to-end" for "the flow ran". The summary now names the evidence it read, in those words, and
  rows are marked `fn:e2e` / `fn:unit` / `--`.

  The gating level is **unchanged** and `.forge/flow-coverage-baseline.json` is untouched — which
  of the four options in ISS-955 is right was explicitly handed over, not taken here. What this
  adds is the figure that decision was missing: the annotated *statement*'s own execution count
  (`s`) is measured on every run and printed as an advisory. Measured 2026-09-07 against a green
  129-file integration suite (980 tests, exit 0): **0 of 7 reached steps** fail the statement rule.
  `release/deploy` reads `fn=3 stmt=3`, because the statement just below its annotation is the early
  return itself. Moving to statement-level evidence would have re-opened nothing and caught nothing;
  the words were the entire defect. Proven equivalent to `origin/main` on one report both ways —
  exit 0 with the same seven rows, and exit 1 naming the same single `release/deploy` when that
  function's counters are zeroed. `.forge/conformance.json`'s `owns` line for the behaviour axis
  claimed the same thing the summary did — *"whether every declared flow step is executed
  end-to-end"* — and is rewritten with it; the axis `level` and both baselines are untouched
  (ISS-955).

- **`pnpm verify` ends on a tally, so nobody totals twenty-two rows by eye.** ISS-938 split `skip`
  and `n/a` out of `ok`, but the run still finished without saying how many checks that left
  passing. It now prints `N passed · M did not run · K red`, with `skip` and `n/a` counted as *did
  not run* and never folded into `passed` — the fold the five marks exist to prevent. The marks
  moved to `scripts/lib/verify-report.mjs` with the tally, because `verify.mjs` executes its whole
  run at import and nothing inside it could be unit-tested; both are now pinned by
  `lib/verify-report.test.mjs` (ISS-955).

- **A second `mark_merged` no longer answers as though it had stamped anything.** The first stamp
  wins by design (ISS-286), but the caller was told `merged` either way, so a later mark — a
  corrected note, a different target, a more accurate time — changed nothing while answering
  identically, and the audit comment it wrote read as the justification for a timestamp some
  earlier write had set. Observed 2026-09-07 on ISS-925: a throwaway probe claimed `merged_at` and
  the real note never moved it. `applyMergeMarker` now answers `already_merged`, and the audit
  comment says the value belongs to an earlier write and that `unmark` then `mark` is the only
  correction — which itself re-blocks every dependent. The stamp is now `WHERE merged_at IS NULL`,
  the same predicate the other two writers use, because `RETURNING` reports the row *after* the
  write and so cannot answer "was it null before".

- **An issue whose code merged and deployed is no longer re-dispatched as claimable work.**
  ISS-920 and ISS-931 both had their change on `origin/main` and serving production traffic while
  the tracker read `open`, because the run that owed the close died before writing it. The
  reconciler's rescue pass selects exactly that shape — `open`, no active job — and re-enqueued a
  drive job for it every minute. `merged_at IS NULL` is now a clause on that query, and the refusal
  is not silent: a new sweeper pass (`detectOwedCloses`) surfaces merged code sitting under a live
  status with no job and no running run to the project's admins, deduped on
  `issue:<id>:owed-close` and cleared when the issue reaches a terminal placement. Neither pass
  closes the issue — `merged_at` is caller-asserted, so the honest act is to put it in front of
  someone who can check the branch.


- **A gate now says whether the defect is in the repo or on the box it is running on.** Three
  checks reported an environment condition as a repository failure, in a signal with no field in
  which to say which it was. All three survive a serial re-run identically, so they wear the exact
  signature a reader is told to trust as a real defect.

  `pnpm verify` in a checkout with no `node_modules` reported `FAIL R7 the relations gate can
  resolve the graph it claims to cover` and `conformance: claims "hardened" and does not meet it`.
  Neither was true — `archmap` and `tsc` were not on disk — and nine checks were affected, not the
  two the report named. Each check now declares what it `needs:`, resolved against the filesystem
  by `scripts/lib/prerequisite.mjs` before the checker is spawned, and a check whose prerequisite
  is absent reports `n/a` naming it and the command that installs it. `conformance-status.mjs`
  reports such an axis as having no measured level rather than level 0, and `conformance-audit.mjs`
  reports `R7` as unanswered rather than as a rule this repo fails. `verify` still exits 2 and
  nothing new goes green: an unrun gate is no evidence, and what changed is only the sentence a
  reader gets. A skipped check now prints `skip` rather than `ok`. (ISS-938)

  The integration suite dropped and recreated one fixed template database, `forge_test_tpl`, so two
  runs entering global setup together destroyed each other's template and the loser reported
  `template database "forge_test_tpl" does not exist` — a failure naming a Postgres object, on files
  the change never touched. The template and each worker's clone are now named for the run that
  created them (`tests/helpers/scratch-db.ts`); a run drops only what it created, and what a crashed
  run left behind is reaped by age. `db.ts` and `container.ts` say `this is an ENVIRONMENT
  condition, not a failure of the code under test` for the failures that remain. (ISS-937)

  `forge-runner-core`'s `mcp::config` tests wrote to a fixed path under the shared
  `~/.config/forge-runner/mcp/`, so two `cargo test --workspace` runs collided and the loser
  panicked on a file the winner had unlinked. The tests now write into a directory belonging to the
  process, through a `write_in` seam, and keep asserting that the file *name* is stable — which is
  the property they exist for and the reason randomising it was not the fix. (ISS-939)


- **A cross-field pipeline-config rule was enforceable on one write and bypassable by two.** The
  `PATCH /projects/:id/pipeline-config` validator ran the schema over the PATCH, and the service
  then merged that patch onto the stored document without re-validating the result. Any rule the
  schema declares across two keys — the `intakeGate` + `poolBacklog` pairing added above is the
  first, but nothing about the hole was specific to it — therefore held only against an operator
  who wrote both halves at once, and fell to anyone who sent them one at a time in either order.
  The merged document is now re-validated before it is stored, and the refusal arrives as
  `CONFIG_CONFLICT` carrying the schema's own message, which already names both settings. A stored
  config that ALREADY fails the schema is not refused: the write did not cause it, and blocking
  there would answer an unrelated edit with a rule the operator did not break and leave them no
  edit that succeeds.

- An issue's chip on its detail screen read its bucket's word, not its status: `statusToChip` folds
  `draft`, `open`, `confirmed`, `clarified` and `approved` all onto `queued`, so a `draft` — which
  nothing is working — displayed as "Queued". It now carries its true lifecycle label, which is
  what every other issue-domain chip already did.

- **A collapsed run of identical attempts now says which attempts it stands for, without a
  mouse.** The Activity feed folds sixteen identical deaths into one line carrying `×16`, and the
  attempt numbers behind that count lived only in a hover tooltip on a badge nothing could focus.
  The sentence is now carried in the row itself, so a screen reader is told which attempts folded.

- **Every chart went blank on a server whose Postgres was not set to UTC, and nothing said so.**
  The metrics timeseries built its bucket list in JavaScript floored to UTC midnight, then grouped
  the rows in SQL with a bare `date_trunc`, which Postgres evaluates in the database session's
  timezone. On a UTC database the two agreed; anywhere else every row landed in a bucket the
  densifier was not looking for, the join matched nothing, and the series came back as zeroes with
  a `null` rate. No error, no warning — a chart reading "this project did no work" is
  indistinguishable from one reading "this project's rows were all discarded".

  All nine bucketed metrics were affected (cost, throughput, cycle time, queue wait, runner
  utilization, cache hit rate, pass rate, approve rate, queue depth), and so was the whole admin
  overview, which had the same JS-floors-UTC / SQL-floors-session split behind a different
  function. Two more surfaces reported the wrong calendar day rather than an empty one: the
  per-project daily analytics and the usage-record daily breakdown both labelled a day by the
  server's clock. One truncation helper now pins all of them to UTC.

  Surfaced by `core-integration` failing only on developer machines in UTC+7 while CI, whose
  Postgres is UTC, stayed green — the test was right and the query was wrong. (ISS-942, ISS-954)

- **A resume, an answer or a steer no longer reads as a cancelled run in the interventions
  breakdown.** The per-issue rollup returned by the interventions endpoint had been sorting events
  by a source name that stopped being accurate months ago: only `manual_cancel` was recognised, so
  every operator resume, every answer and every steer fell through to the "user flipped the run"
  bucket. The totals were right and the breakdown was not — an operator rescuing work was charted
  as an operator killing it, which is the exact mislabelling the source-naming migration had been
  written to end. Each source is now counted as what it is. (ISS-884)

- **A terminal status flip and its audit row can no longer be separated by a crash.** The single
  kernel-transition writer documented itself as writing the status change and its audit trail
  together, and did for callers inside a transaction — but twenty call sites hand it a plain
  connection, where the two statements committed independently. A failure between them left a job
  or run terminal with nothing recording who ended it, which is the same silence this release
  closes elsewhere, produced by the audited path itself. Both writes now always commit together.
  (ISS-884)

- **`POST /api/memory/search` ignored the `strategy` you asked for and told you it had honoured
  it.** The route validated `strategy` in its body schema and then never passed it to
  `runMemorySearch`, which applied its own `'semantic'` default — so a caller asking for `keyword`
  or `hybrid` got a semantic search back, labelled `strategy: 'semantic'` in the response, with no
  error anywhere. The MCP tool always forwarded it, so the two surfaces disagreed for as long as
  the route existed. Found while annotating the pair as a declared contract (ISS-894); the route
  now forwards the field, and an integration test asserts the requested strategy in the response
  rather than in the hits, because a hits-only assertion passes on both the broken and the fixed
  route.

  The new case fits under the file's frozen size budget rather than raising it: the twelve
  `process.env.X ??=` lines in `beforeAll` are now one loop over a module-level `ENV_DEFAULTS`, and
  the keyword strategy needs neither a seeded row nor an embedding stub to report itself back. The
  `form` axis baseline may only move down, so a waiver was not available here — which is the gate
  working.

- **A valid Coolify token that was merely under-scoped told the operator to replace it.** Every
  Coolify v4 route sits behind an ability middleware (`api.ability:read`, `:deploy`, …), so a token
  Coolify recognises but that lacks the ability a route wants answers **403**, not 401. Forge folded
  both into `needs_reauth` — documented as *the stored credential was rejected … the operator must
  re-enter the credential* — so the fix on offer was to mint a new token, which reproduces the state
  exactly. It was easy to hit: the healthcheck lists `/api/v1/resources` and needs `read`, the deploy
  posts `/api/v1/deploy` and needs `deploy`, so a read-scoped token passes Test-connection and is
  refused only at deploy time.

  A 403 is now its own health state, `needs_scope`, on both the health path and the deploy path, and
  its message names the ability the token lacks and the route that wanted it — "Coolify recognised
  the API token but refused `POST /api/v1/deploy` (HTTP 403): the token is missing the `deploy`
  ability (`api.ability:deploy`)". The connections directory renders it as **Needs wider scope**,
  distinct from **Needs re-auth**; both still bucket to `attention`, because both are things an
  operator can fix. `needs_reauth` keeps its documented meaning: the credential is not recognised.

  The rotation fallback already declined to retry a 403 with `previousApiToken` — a second token
  cut from the same scope fails identically — and that is now pinned by a test rather than left to
  be re-derived. The `/api/v1/resources` healthcheck is unchanged: swapping it for the cheaper
  `GET /health` would narrow the ability surface but would also stop resolving every configured
  target, which is what catches a stale `resourceUuid` deploying the wrong repo.

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

- **What's New no longer lists the same category several times over for one release.**
  `[Unreleased]` had grown nine `###` headings from append-only edits — Added three times, Fixed
  three, Changed twice — and the feed renders one section per heading, so a single release read
  ADDED, FIXED, CHANGED, REMOVED, ADDED, FIXED, ADDED, CHANGED, FIXED down the page. The headings
  are folded to four with every bullet carried across unchanged, and `scripts/lib/release-record.mjs`
  gained a `structure` rule that refuses a repeated `###` inside one release section, so the shape
  cannot drift back one append at a time: it reported five repeats against the file as it stood and
  none after. Two fixes that had shipped with nothing written about them went in at the same time —
  failure classification, and the vendored fonts that stopped a font host from failing a backend
  deploy. Shipped 2026-09-02; this line was owed then and is written now. (ISS-870)

### Changed

- **The rules `forge_issues` carries now reach the model reading them, in a third fewer characters.**
  That tool's description was 6,381 characters and the largest single item in the nine-tool catalog
  every assistant turn ships — more prose than the 6,619-character schema beside it. The chat
  front-end truncates every tool description at 1,024 characters, so most of it never arrived:
  measured at `b4850a2e`, the cut landed mid-word inside the sentence that tells a caller to read
  `hasMore` before calling a count complete, and everything after it — that `plan` and
  `acceptanceCriteria` belong to the pipeline and pre-filling them is the `plan-by-hand` red flag,
  that `data.labels` on an update is a replace-set that clobbers what you do not re-send, the whole
  of relations and the merge mark — reached that model in no form at all. The description is now
  4,168 characters, and the rules a caller cannot act without are ordered ahead of the cut rather
  than left behind it. **No rule was traded for the space.** Five things were dropped and only five:
  the upload walkthrough `forge_uploads` already carries verbatim in the same catalog, two
  server-side effects a caller cannot act on, the `blocks|relates` vocabulary the schema declares as
  an enum, and two error-code lists the refusals already name themselves. Everything else is still
  there, and the four rules the issue named as must-survive are held by a test that goes red when
  any one of them is deleted or has its meaning reversed. The input schema, the handler, the action
  allowlist and the chat guards are byte-identical (ISS-984).
- **The status menu offers the moves a rung actually has, instead of all fifteen.** Opening the
  status picker used to show the same fifteen choices on every issue at every stage, ordered by
  nothing a reader cares about: a closed issue was offered fourteen moves past the one that is
  real, and a dropped issue — whose whole point is that it has no way out — was offered fifteen.
  Three of the fifteen were worse than clutter. `clarified`, `waiting` and `tested` are retired:
  nothing picks work up at them, so choosing one succeeded, moved the issue somewhere nothing
  watches, and left it there until a person went looking. Twenty-one issues were sitting that way
  across all projects. The menu now shows what that stage can really do — the move that carries
  the work forward first, then the ways to pause or send it back, then the two ways to discard it,
  each group set apart — and the retired three are not on it at all. A closed issue offers
  "Reopened" and nothing else; a dropped one says plainly that it is re-filed rather than reopened.
  Where two moves would have read as the same word, the menu now says which is which. Selecting
  several issues and setting their status together follows the same rule, and says so in words on
  the bar — whether the control is off because the selection has nothing in common or because the
  moves are still loading — rather than in a tooltip a keyboard or touch user never sees. The list
  itself is no longer kept in two places: it is the one the pipeline declares, now read straight
  from it, so the menu cannot drift from what the pipeline says a stage does next. The API stays
  deliberately permissive: it still accepts moves the menu no longer offers, so nothing already
  automated against it breaks.


- **An issue may rest at `confirmed` or `approved` again, and a master can see it there.**
  Five statuses were cut from the forward ladder on 2026-09-10 and left in the enum to be drained.
  Two of them were not dead: the driver that runs every autonomous project walks
  `open → confirmed → approved → in_progress → developed → testing → awaiting_release → closed` and
  earns each rung with a record, so it kept writing two statuses the kernel called retired — and the
  kernel accepted them in silence, because the transition table is documentation and the enum is the
  gate. That is how a triage run wrote `open → confirmed` and the row then sat invisible, on a
  status no job dispatches at, until a person moved it by hand. The rule the retirement was judged
  against has not changed — **a rung earns its place when a different party owes the next move at
  it** — but the answer has: under the wave model a reader triages the issue and a different run
  executes it, so `confirmed` (a reader has said what the issue is; an executor owes the next move)
  and `approved` (a decision, a plan and criteria exist; the build owes it) both clear that bar
  where they did not under a single agent walking the whole ladder. Both are live rungs of the
  canonical ladder, of the transition table and of the lifecycle guide; both are places a park now
  returns to rather than being forced through `open`; and `clarified`, `waiting` and `tested` stay
  retired, since each only ever recorded that a phase inside one session had finished. No status
  was added or removed, and no migration ran — every row already resting on either rung is exactly
  as reachable as before. **Nothing dispatches at either rung**, so a row rests there visibly only
  where its project admits the status to its master's backlog; forge-dev now does, and the other
  nine projects holding such rows are each their owner's to open. Reviving cost no change in the
  driver's own repository, which is the half this one cannot edit; retiring the two would have
  required one.

- **A paired box's agents now come from the box, not from core. Core mints no drive job, and the
  box's own master decides what it runs.** An issue arriving at the entry status used to produce a
  `pipeline_run` and a `drive` job pushed at whichever runner the picker chose. Core now publishes
  only a wake, and a master agent already resident on the box reads the pool, groups the issues it
  wants, and opens **one run session** — one worktree, one pane, one ledger row — for the group. The
  manual **Run** button changed shape with it: it releases the issue and wakes the boxes, so an
  operator who presses it and sees no job has not hit a bug, they have a project no box is bound to
  serve. That case now reports itself instead of being counted as a rescue.

  **What an operator sees when a close only half-lands.** A run closes on three observed marks — the
  session went terminal, the worktree left disk, and each issue's lease came back — and every one of
  them is set by reading the world back, never by an agent saying it is done. A run carrying three
  issues that returned one lease reads as exactly that: partially closed, with the ledger naming the
  two issues still out and the sweep retrying them, rather than a green close over work nobody
  finished. Two independent triggers close a run whose master is gone: the box's own sweep, which is
  fast but cannot answer for a box that lost power, and core's reaper on a heartbeat silent for ten
  minutes, which can. Ten minutes is two of the *slowest* beat a rate-limited box makes, so
  throttling never costs a healthy run its worktree.

  Deleted in the same change: the push path, the per-project dispatch tick, `maxConcurrentIssues`
  (migration 0206) and the supervision cluster that watched masters from core. The design document
  this consumed, `docs/proposals/master-orchestration.html`, is retired; the two flows that replace
  it are `docs/flows/run-session-lifecycle.html` and `run-session-close.html`. (ISS-933)

- **Sixteen major dependency lines moved up at once, with the source migrated to each new API.**
  `@hono/node-server` 1→2, pg-boss 10→12, vitest + `@vitest/coverage-v8` 3→5, `@types/node` 20→26,
  cron-parser 4→5, zxcvbn-ts 3→4, nodemailer 9→10, testcontainers 11→12, `lucide-react` 0.564→1.41,
  jsdom 28→30, `@testing-library/jest-dom` 6→7, dependency-cruiser 16→18. Five breaking API changes
  were carried rather than pinned around: cron-parser's default `parseExpression` is now
  `CronExpressionParser.parse`; `@zxcvbn-ts/core` dropped the `zxcvbn` / `zxcvbnOptions` singletons
  for a `ZxcvbnFactory` instance; pg-boss moved to a named `PgBoss` export; vitest 5 removed
  `poolOptions` (parallel forks is the default) and now hard-errors a `vi.mock` written below a
  module's top level, so six integration files had theirs hoisted; and `lucide-react` 1.x removed
  the `Github` brand glyph, so the `github` icon maps to `GitBranch`. **TypeScript is held at 5.x**:
  7.0's native compiler breaks dependency-cruiser's TS resolution, which blinds the vendored archmap
  relations gate (0% of the graph resolved, `archmap check` then passing over an empty graph) — the
  upgrade waits on toolchain support in the archmap/dependency-cruiser line rather than shipping a
  silently unenforced gate.

- **The interventions metric now counts a hand on `agent_sessions`, a hand on a non-terminal
  status, and a hand that deletes the row — and it stopped charging an ordinary auto-release to a
  human.** ISS-884 taught the ruler to see a `psql` terminal flip on `jobs` or `pipeline_runs` by
  the absence of a `forge.kernel_txn` marker, and recorded the other three shapes of hand-written
  intervention as permanent edges of the instrument. They were not edges. Each was uncounted for the
  same reason — only the TERMINAL writers stamped the marker — so widening it to every legitimate
  status writer and row deleter closed all three at once, with no new discriminator.

  `db/kernel-marker.ts` now owns the stamp (`withKernelMarker`), `applyKernelTransition` is
  one of its callers, and `0219_unaudited_transition_reach.sql` widens the two triggers to any
  status change, adds the same trigger on `agent_sessions`, and adds an `AFTER DELETE` arm that
  records `<status>→deleted`. A DELETE of a `projects` or `issues` row cascades kernel rows in the
  parent's transaction, so the parent's marker covers every child it takes with it.
  `db/kernel-marker-guard.test.ts` is what keeps this true as the tree grows: it reads the
  SHAPE of a `.set()` argument rather than its status literal, which is how it catches
  `PATCH /api/agent-sessions/:id` writing `patch.status` — the writer whose invisibility to the
  older literal-scanning guard is the whole reason the session class was uncounted.

  It also fixes an overcount ISS-884 shipped on the arm it did prove. The detector is
  `AFTER UPDATE OF status`; the I1 backstop is a `BEFORE` trigger that rewrites `NEW.status` to
  `cancelled` when an active child is written under a terminal run. An ordinary requeue writes
  `queued`, stamped nothing, and I1 turned it terminal — so releasing a held job whose run had
  closed was charted as manual SQL. Asserted as a regression, red on the parent commit.

  Two premises recorded as reasons in `docs/modules/control-observability/README.md` did not survive
  contact with the tree and are corrected there rather than quietly dropped: the retention sweeper
  deletes `job_events`, never `jobs`, and there is no in-code delete of a `jobs` or `pipeline_runs`
  row anywhere. One edge stays, and it is not a shape of write — a migration that backfills a
  `status` is charged to the metric, so such a migration stamps the marker itself. Priced: the
  session PATCH no longer skips its transaction on a status-free heartbeat, costing one
  `SELECT set_config` per PATCH, because a marker gated on a runtime condition is one the guard
  cannot see.

- **The rule that decides which MCP tools may be deleted was measured against the copy of the
  `forge` CLI the fleet actually runs, and three tools it had cleared turned out to have live
  callers.** The rule gated a deletion on a tool's *device* call count and on the replacement route
  accepting a device token. ISS-931 changed what both clauses are about, and the page had not
  caught up.

  A device count is no longer a record of traffic that happened — it is a forecast of traffic that
  returns. `requirePat` refuses a device, so those ~20 tools' counts stopped rising, but the
  sessions behind them are paused rather than retired: a box installs a `runner-v*` that writes the
  job token and the same MCP client resumes against the same tool list, on a PAT. So the count
  stays a refusal, and the clause that genuinely went obsolete is the second one — the replacement
  must accept a `forge_pat_*`, because that is what every returning caller holds.

  The gate now names three caller populations rather than one, and the second is what this change
  found. The `forge` CLI on the boxes holds a PAT, so ISS-931 left its access untouched and its
  calls are indistinguishable from any other token traffic — invisible to a device split.
  Re-measuring against the installed artifact (forge-plugin 3.35.140, which this repo cannot see)
  corrected the protected list in both directions: `forge_memory.search`, `forge_projects.get` and
  `forge_projects.list` are called by it and had been filed *free to go*, while
  `forge_projects.create` was listed as blocked with no call site in it at all. Two more,
  `forge_memory.write` and `forge_memory.feedback`, are hard-coded nowhere and reached through
  `forge call`, the raw passthrough the CLI's own guide text points agents at — so a grep for tool
  names is necessary and not sufficient. `forge_memory.search` also has a caller no audit query
  would surface: the runner writes "Recall memory FIRST — `forge_memory_search`" into every project
  workspace's orientation.

  Deleting one of these is not uniformly fatal, and the page now says which is which: the plugin's
  `callTool` degrades softly where its `soft` flag is set, so `forge_memory.search` would have gone
  quiet rather than loud. Only `forge_projects.list` exits.

  Separately, the page's *stay* row listed two of the four keep-forever families, leaving
  `forge_phase` and `forge_step_handoff.*` filed as deletable — and all four have REST twins, so
  the twin test does not protect them.

  No tool is deleted by this change. `docs/architecture/agent-surface.md` carries the rule,
  `docs/flows/mcp-tool-deletion.html` draws the decision path, and ISS-946 carries the fact that
  the third population cannot be measured from a runner box at all. (ISS-894)

- **An attachment name on an issue now means one file, and a refusal says which file already
  holds it.** An issue or a comment could carry the same attachment name twice, so a record citing
  that name resolved to two documents and no reader could tell which was meant. One tracker issue
  had eight attachments under six names, and ten verdict records citing a name that pointed at two
  files. Nothing refused the second upload, and nothing in the issue view made the duplication
  visible.

  Uploading under a name the issue or comment already carries is now refused with
  `ATTACHMENT_NAME_TAKEN`, and the refusal names the document that already holds it — its id and
  its download URL — so you can cite that one, delete it, or pick a different name. On an issue the
  id is what the delete verb takes, so refuse → delete → retry closes; on a comment there is no
  delete yet, so the way out there is a different name.

  Names that are not written in the Latin alphabet are compared as themselves rather than as the
  underscores they used to collapse into: `报告.pdf` and `设计.pdf` are two documents, not one
  refused pair. The two Unicode spellings of one accented name are now one document rather than
  two. Uploads racing for the same name are serialised, so exactly one of them wins instead of all
  of them landing.

  Pasting two screenshots into the New issue dialog no longer loses both. The browser calls every
  clipboard image `image.png`, and a create that cannot attach one file attaches none — so the
  second paste is now staged under its own name, and a create that still drops a file says so
  instead of reporting success.

  Downloading a non-Latin name works, which it did not the moment names stopped collapsing: a
  `Content-Disposition` header value cannot carry a character above 255, so `报告.md` uploaded fine
  and then answered its own download URL with a 500. The served name is now RFC 5987 encoded, with
  an ASCII fallback for clients that read only the plain parameter. Hindi, Arabic and Hebrew names
  are compared as themselves too — combining marks were still being replaced, so `किताब.pdf` and
  `कुताब.pdf` were one name in exactly the way `报告.pdf` and `设计.pdf` had been. And a name too
  long to store is refused with `INVALID_NAME` naming the limit, rather than trimmed: the limit is
  180 bytes of UTF-8 because the filesystem counts bytes (an 81-character Chinese name overflows
  where 200 ASCII ones did not), and trimming would have merged every name sharing a prefix into
  the single row this whole rule exists to prevent. (ISS-963)

- **The always-inject flag now says what it buys, and stops implying the rule will be followed.**
  Flagging a project fact `alwaysInject` splices its full body into every agent prompt under
  *"Hard rules for this project — always-injected by the project owner. Follow them exactly"*, and
  nothing has ever read the rule back: no gate refuses a step that ignored it, no step is asked
  whether it complied, no surface counts observance. The settings tab nevertheless told the owner
  to *"use it for hard rules the agent must always follow"* — an enforcement promise the control
  plane was not making.

One sentence, `ALWAYS_INJECT_GUARANTEE_NOTE`, now states the split: the body reaches every
  agent prompt, and nothing checks whether the agent followed it. `GET`/`PATCH
  /api/projects/:id/project-facts` both serve it — the PATCH answer replaces the GET's in the
  tab's query cache, so a field on only one of them would leave the screen on the owner's first
  save — and the browser holds no second copy of the string. `ALWAYS_INJECT_ENFORCEMENT_NOTE`
  carries the detail a settings tab has no room for, appended to `forge_config`'s description and
  rendered into the `project-settings-and-test-credentials` guide: which three checks do not
  exist, and the one obligation on this deployment that DOES have a readback — the UX contract,
  whose rules are `ux_contract_rules` rows with ids and whose violations agents cite in
  `ux_findings`. That is the price of an enforceable rule, ids to cite, and a free-text fact has
  none — which is why this is a correction to the claim rather than a new checker.

  **Found on the way, and fixed here.** `forge_config`'s issue-aware branch resolution read the
  issue through a query that selected only `session_context`, while
  `extractIssueBranchOverride` prefers `metadata.branchConfig` — so an issue carrying a real
  per-issue base-branch override was answered with the project default, silently, and the comment
  above the cast still said the `issues.metadata` column had not landed. It had. The reader now
  selects both fields and is named `readIssueBranchInputs`; its single caller uses the shared
  extractor instead of a hand-rolled copy of the same precedence. The unit lane could not have
  caught this — it mocks the row, and a mocked row carries `metadata` whatever the SELECT asked
  for — so the assertion is an integration test against real Postgres.

  The agent's own prompt is unchanged, deliberately. Telling an agent inside a rule that nothing
  checks the rule converts an unverified rule into an ignored one; the false promise was the one
  made to the owner, and that is where it was withdrawn.

- **Pairing a box is now issuing it a token, and the device credential is gone.** `devices` was
  both the machine and its secret — `token_hash`, `token_prefix` and an argon2 verifier of its own.
  It is a registry of machines now. `POST /api/devices/login/approve` takes an optional `agent_id`,
  and the poll hands back an ordinary PAT (the approver's) or that agent's AAT, carrying the new
  `personal_access_tokens.device_id`. `requireDevice`, `requireUserOrDevice` and the `/ws` upgrade
  all resolve the box from that one column through `verifyDeviceCredential`; `auth/deviceToken.ts`
  and `verifyDeviceToken` are deleted. Four auth middlewares became two species, then one.

  A token with no `device_id` presented to a device route is refused **by name** rather than read as
  its owner — that fallback is the `device.ownerId` fiction, where a machine borrowed a person's
  whole account, and the refusal names `forge login` as the remedy.

  **Every paired box must re-run `forge login` once.** There is no backfill and there could not be
  one: core holds argon2 over a plaintext it never had, so an existing device token cannot be mapped
  to a PAT. Migration `0215` refuses to drop the credential columns while any non-revoked device
  still holds one and names the rows, so the break is read at deploy time rather than discovered as
  a dark fleet. `devices` rows keep their ids, so every `runners` binding, `jobs.device_id`,
  `agent_sessions.device_id` and `projects.default_device_id` reference survives.

  `agency` reads the token OWNER's `users.kind` and nothing else (ISS-932 wave 4). A credential is
  NAMED after the box it was issued to so a re-pair can find and rotate the same row, but that name
  is a label: nothing reads behaviour off it, and a person's token called `device:` is inert. Read
  `agency` any other way at any door and the ISS-786/812 evidence gates and the comment mandate stop
  agreeing about who an agent is.


- **An agent session authenticates `/mcp` with its own job token, and a device token no longer
  authenticates `/mcp` at all.** Two credential species reached the MCP transport, and one of them
  was a fiction: for every PAT call, core fabricated a `Device` row — a token id in its `id` column
  and `__pat_synthetic__` for a name — and handed it to fourteen tools. The membership helpers those
  tools used read only that stub's `ownerId`, so none of the fourteen ever consulted the PAT's
  `projectIds` allowlist. `requirePat` (renamed from `require-pat-or-device.ts`) now accepts
  `forge_pat_*` and refuses every other bearer, and `McpContext` has no `device` field to
  reintroduce. `forge-runner` writes the job's own `job:`/`session:` token into the per-job
  `.mcp.json` and never falls back to the device token; `/ws` and the device REST routes are
  unchanged, because that is the daemon's own channel.

  Two reachability consequences are deliberate and documented rather than papered over. A
  non-member of a project now reads `NOT_FOUND` from those fourteen tools instead of `FORBIDDEN`,
  so a tool is no longer an existence oracle. And an admin-gated tool asks for the `admin` scope,
  which a machine-minted token does not carry — an operator who wants `forge_skills.*`,
  `forge_runners` writes or `forge_reconcile` from an agent mints a PAT with `admin` rather than
  having the mint widened, because ambient admin authority is the thing ISS-927 removed.

  This ships on two clocks and the second one is a binary: core refuses at deploy, a runner box
  changes at binary install. A box on an older `forge-runner` writes the device token, every MCP
  call 401s at once, and the refusal names that remedy in its own text rather than leaving an
  operator to read it as a core outage. The two `forge_project_pm` actions that genuinely need a
  paired device (`dispatch`, `write_decision`) refuse by name and list the actions a PAT can reach;
  `write_decision` has no REST twin left, and that open decision is
  `docs/proposals/pm-dispatch-has-no-rest-twin.md`. (ISS-931)

- **`rollback` on a production Coolify binding is now the action, not a paragraph.** Free text
  there described a procedure somebody would carry out by hand under time pressure, from
  instructions nothing had verified were still true. A Coolify binding now declares
  `rollback: {"mode":"coolify-image"}` and Forge performs it; free text is refused on save, with a
  message naming the replacement. It stays exactly as it was for every other channel — Postman,
  Epodsystem, Sentry, GitHub, Rocket.Chat and the `agent` channel have no API that expresses a
  rollback, which is the one thing the field is now for.

  Bindings already holding prose are not rewritten and not deleted. They are named: project
  settings shows the declaration as *free text — not executed*, readiness reports a new
  `rollback-prose` gap, and a release batch on that project is told to **abort** and is shown the
  stored text so a human can convert it, rather than being handed a paragraph to improvise from.
  That is a deliberate break: those projects previously had a rollback an agent would attempt, and
  now they abort until the binding is converted.

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
