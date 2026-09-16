# The forge-plugin coupling

Every place where a change in this repository has a second half in
`github.com/SidCorp-co/forge-plugin`, and nothing in this repository can gate the pair. The two
repos ship on different clocks, `CLAUDE.md`'s carve-out forbids reaching that one by diff, and no
check in this tree fails when the halves disagree — so this file is the record. It replaces the
`cm:guard` / `cm:why` / `cm:edge` annotations that carried it, which ISS-1049 removed.

**Verified against the tree at `33eabd7e` on 2026-09-16.** Every this-side anchor, constant, route
and column below was grepped in the worktree and found. The other side was checked, where it could
be, against the **pinned build artifact** `node_modules/forge-plugin` — the tarball
`packages/core/package.json` resolves at
`codeload.github.com/SidCorp-co/forge-plugin/tar.gz/2f3f40e245dd79c416f1abdbdd52e6487c632b97`
(package version `3.36.22`). **That artifact is a pin, not the plugin repo, and not what the fleet
runs**: a runner box installs its own marketplace clone at its own ref, so a claim confirmed at the
pin is confirmed for the copy `packages/core` compiles against and for nothing else. Claims the pin
could not answer are marked *unverified from this repo* rather than asserted. Tracker rows on the
`forge-plugin` project are not readable from this checkout at all.

---

## The driver's status ladder and the drive prompt

### The five driver statuses

- **This side:** `autonomous-mode.ts:AUTONOMOUS_DRIVER_STATUSES` — `open`, `in_progress`,
  `needs_info`, `closed`, `dropped`. Restated nowhere else on purpose:
  `step-handoff-schema.ts:renderDriveTerminationBlock` and `drive-rules.ts:DRIVE_RULES_TEXT` both
  carry a standing instruction not to list them again, because a third copy is one more list to
  drift inside the same context window and no gate reads it.
- **The other side:** the status table the `issue-flow` skill hands the agent, in
  `plugin/skills/issue-flow`. *Unverified from this repo:* the pinned `SKILL.md` is a short
  front-matter pointer whose body says the method is served by the CLI (`forge guide issue-flow`),
  so no status table is present in that file at the pin.
- **What breaks if they drift:** the driver writes a KERNEL status; the render labels
  (`needs_human`, `paused`, `done`, `running`, from `packages/contracts/src/issue-vocabulary.ts`)
  are translated by nothing on the write path, so a skill naming one hands the agent a value
  `forge_issues` rejects. That is how 27 parks landed on `waiting`, a status `answer-resume.ts`
  never wakes. `issues/autonomous-park.ts` now rewrites an agent's `waiting` to `needs_info`, which
  is a net under one value and not a licence to widen the list. A status added here reaches the
  agent only when the plugin says it too.
- **How you would notice:** nothing notices. The list lived in this repo under
  `packages/runner/skills` until 2026-09-02 and `scripts/check-autonomous-transitions.mjs` failed
  the build when the two diverged; the skill moved to the plugin, that script had nothing left to
  read and was deleted — confirmed absent from `scripts/` at this commit. A second-order signal
  exists but is not this one: adding a status here also drops it from
  `autonomous-mode.ts:BACKLOG_ADMISSIBLE_STATUSES`, and every `pipelineConfig` naming it then stops
  parsing WHOLE, silently disabling that project.

### The eight-rung canonical ladder

- **This side:** `registry.ts:CANONICAL_LADDER` — `open`, `confirmed`, `approved`, `in_progress`,
  `developed`, `testing`, `awaiting_release`, `closed`; and the `confirmed` and `approved` rows of
  `state-machine.ts:transitions`, which are live rungs rather than members of the retired block
  below them.
- **The other side:** `ORDER` in `plugin/src/flow/earned.mjs`. **Verified at the pin**: the same
  eight names in the same order.
- **What breaks if they drift:** the six-rung version of this list omitted `confirmed` and
  `approved` while the plugin walked them. `open -> confirmed` landed on ISS-952 on 2026-09-10 with
  nothing warning and nothing dispatching there. The rule that admits a rung is that a DIFFERENT
  party owes the next move — `confirmed` is a reader having said what the issue is with an executor
  owing the next move, `approved` is a decision, plan and criteria existing with the build owing
  it. The 2026-09-10 retirement judged both against that rule and answered wrong under the wave
  model, which splits those parties. Moving either back into the retired block is a change the
  plugin's ladder does not have, and this repo cannot make it there.
- **How you would notice:** partly. `registry.test.ts` compares this array against the same chain
  spelled in prose inside `PIPELINE_RULES`, so the two in-repo copies cannot diverge. Nothing
  compares either to `ORDER`. Dispatch is no signal: nothing dispatches at `confirmed` or
  `approved` still — `poolBacklog.statuses` is how a row resting on one reaches a master, and a
  project declaring none offers only `open`.

### The reopen fall-through

- **This side:** the `reopen` row of `state-machine.ts:transitions`, which lists `developed` as a
  legal target, and `state-machine.ts:isReopenEntry`, which counts these as real rejections and
  excludes only `in_progress -> reopen`, the system's mechanical recovery.
- **The other side:** `FALLS_TO` in `plugin/src/flow/route.mjs`. **Verified at the pin**:
  `wrong-test` maps to `developed`, `not-met` to `in_progress`.
- **What breaks if they drift:** a failed check sends work back to the rung that owes the proof,
  not to the start. Remove `developed` from the reopen row and the plugin routes a `wrong-test`
  outcome to a target this repo's menu does not offer.
- **How you would notice:** nothing notices at the transition. `state-machine.ts:canTransitionFree`
  permits any non-draft to any non-draft, so the map is advisory — it shapes the menu, never the
  refusal. The mismatch surfaces only as a rung the UI will not offer while the plugin keeps
  sending work there.

### The retired `tested` rung

- **This side:** the `clarified` / `waiting` / `tested` block at the bottom of
  `state-machine.ts:transitions`. Retired statuses kept only until their rows drain; their exits
  are deliberately drain routes onto live rungs rather than the old ladder hops, and no hop may be
  added between two of them.
- **The other side:** the plugin writes `tested` where this flow says `testing`. *Unverified from
  this repo* — the pinned `earned.mjs` `ORDER` names `testing` and not `tested`, so the artifact
  neither confirms nor refutes what a live plugin writes.
- **What breaks if they drift:** `tested` holds the most rows of the three. Dropping it from the
  enum has to move `poolBacklog.statuses` in the same change — sidpeak names it — or that project's
  whole `pipelineConfig` stops parsing.
- **How you would notice:** by the row count on the status, which nothing watches, and by a project
  config failing to parse after the fact.

### The skill name `issue-flow`, and the per-state depth behind it

- **This side:** `autonomous-mode.ts:AUTONOMOUS_SKILL_NAME` (`issue-flow`), reached by
  `autonomous-mode.ts:autonomousStepFor` as the drive job's `skillName` and rendered by
  `user.ts:buildUserPrompt` as the prompt's first line. Nothing in core or the runner resolves that
  name; `skill_registrations` never has and must not start to.
  `state-prompts/index.ts:DEFAULT_STATE_SYSTEM_PROMPTS` deliberately has no `drive` entry for the
  same reason — the driver's per-state depth is the skill, not a block core writes, and
  `mandatoryPreambleBlocks` is where its lane fork lives.
- **The other side:** `plugin/skills/issue-flow`. **Verified at the pin**: the directory and its
  `SKILL.md` exist, with `name: issue-flow`.
- **What breaks if they drift:** the name reaches the agent only as text. The skill is delivered by
  the `forge` Claude Code plugin, installed on a device when a bound project designates it and that
  box has `[plugins] enabled = true` (`config.rs`, and `GET /api/devices/me/plugins` in
  `devices/routes.ts`, unioning `projects.agent_config.plugins` through
  `plugins/designation.ts:readPluginDesignations`). A project missing either dispatches a driver
  told to run a skill it does not have, and the turn proceeds with whatever the model makes of a
  slash command that resolved to nothing.
- **How you would notice:** nothing notices. `pipeline-config-schema.ts` refuses a per-stage
  `skillName` with a message naming this constant, but no surface reports that a designated plugin
  failed to install or that the invocation matched nothing on the box.

### The drive preamble's transport and vocabulary

- **This side:** `drive-rules.ts:DRIVE_RULES_TEXT`, the autonomous lane's half of the two mandatory
  preamble blocks. It names `forge-runner api` as the transport and names no ladder.
- **The other side:** `plugin/skills/issue-flow` (*unverified from this repo*, as above).
- **What breaks if they drift:** the skill and this preamble are read in ONE context window and
  must name ONE transport and one status vocabulary. They disagreed until 2026-09-02 — the skill
  named `forge-runner api` and nothing else, the preamble named `forge_step_start`,
  `forge_issues.update` and a nine-rung ladder — and the agent believed the preamble: 4,806
  `forge_step_start` and 4,268 `forge_step_handoff.write` device calls, every one on a project in
  autonomous mode. Which half moves is a choice, and the skill won it: the job PAT is minted per
  job, scoped to one project and revoked when the job goes terminal, where the device token the MCP
  path used was long-lived and fleet-wide. This is not "the driver cannot call MCP" — it can, and
  the integrations block still tells it to.
- **How you would notice:** only by the traffic, after the fact, and only if someone reads it.

### The termination block's scope literals

- **This side:** `step-handoff-schema.ts:renderDriveTerminationBlock`. It owns exactly what the
  skill cannot know — the scope literals for the handoff write — and nothing else. Adding process
  here duplicates an authority that is already gated.
- **The other side:** the handoff protocol in `plugin/skills/issue-flow` (*unverified from this
  repo*).
- **What breaks if they drift:** two descriptions of the same protocol in one context window, one
  of which no reviewer of the other repo has seen.
- **How you would notice:** nothing notices.

### The park's `needs` field

- **This side:** `apply-transition.ts` — the `needs` field of the transition input. Optional on
  purpose, and the absence is not a default: a park without it keeps exactly today's behaviour, a
  reason comment and no question row. How often it is absent is a query (a `needs_info` park with
  no `agent_questions` row on its issue), never a counter.
- **The other side:** the driver that writes parks, which ships from the plugin repo on its own
  clock. *Unverified from this repo.*
- **What breaks if they drift:** making `needs` required refuses every park whose writer omits it,
  the moment it
  deploys, because the writer of those parks would not carry the field until its own release.
- **How you would notice:** immediately and catastrophically — every autonomous park on the fleet
  starts failing its status write. That is the outcome the optionality exists to prevent, not a
  monitor.

---

## The comment and authorship protocol

### `authorDeviceId` as the agent marker

- **This side:** `forge-comments.ts:serialize` projects `authorDeviceId`, and `forge-comments.ts`
  resolves it on create through `lib.ts:principalAuthorDeviceId` — from the caller's OWN token
  (`job:` / `session:` to the job's or session's `device_id`), never from a principal. `authorId`
  stays the human owner. Asserted by `forge-comments.test.ts`: a person's PAT inserts
  `authorDeviceId: null` and succeeds.
- **The other side:** `answered()` in `plugin/src/flow/earned.mjs`. **Verified at the pin**: a
  falsy `authorDeviceId` later than the park is what it counts as a person's reply. The same field
  is read at `src/flow/record/record.mjs` and carried in the CLI's comment projection at
  `src/tracker/routes.mjs`.
- **What breaks if they drift:** this field is the whole of what `answered()` asks with, now that
  `is_ai` is gone (confirmed: no `is_ai` column in `db/schema.ts`). Drop it from the projection and
  every screen the driver parks on becomes unanswerable, because the agent's own comments read as a
  person's and the park answers itself. A wrong non-null is the inverse: a person's comment read as
  an agent's, so the park never answers. Non-null was also the ISS-638 FK trip — a PAT principal
  has no `devices` row and the stub `mcp/handler.ts` fabricated for it carried the PAT *token* id,
  failing comment creation for every PAT caller. ISS-931 deleted that stub; since then a
  PAT-authored agent comment is marked at all, which it never was before.
  Read the column precisely: non-null identifies the BOX an agent credential wrote from, which on
  these write paths is the only agent marker left — not "the column means an agent".
- **How you would notice:** the null assertion is held by a test in this repo. The **meaning** of
  the non-null — an agent, to `answered()` — is held by nothing here.

### A reference to another project's issue is not judged

- **This side:** `cells.ts:SHIPPED` — the `report` cell deliberately omits
  `issue-references-exist`, carrying `COMMENT_HAS_TEXT`, `STATUS_MATCHES_THE_ROW`,
  `NO_ROOM_BROADCAST_CARRIED` and `NO_REDACTED_SECRET` only. Held by `screen.test.ts` and end to
  end by `message-screen-e2e.test.ts`.
- **The other side:** `CLAUDE.md`'s carve-out — a defect in the plugin repo leaves as an issue on
  the `forge-plugin` project and is named in the comment.
- **What breaks if they drift:** measured, not assumed — in an 18-issue sample of this project's own
  comments, 6 of 391 cite a `forge-plugin` key. An existence rule on the `report` cell would refuse
  the mandated behaviour once every 66 comments. A reference this project does not hold is very
  likely another project's, so it is not judged; a status ASSERTED of an issue this project does
  hold still is.
- **How you would notice:** two tests in this repo go red, and the cell's rule ORDER is itself
  frozen by `legacy-verdicts.fixture.json` in a differential test that compares lists rather than
  sets.

### Two agents settling a cross-repo change in one room

- **This side:** `proactivity.ts:agentAuthors` reads agency off `users.kind === 'agent'`, not off
  "is this a handle of this room"; `proactivity.ts:isAgentMessage` treats an assistant row as this
  room's own handle regardless of its author column.
- **The other side:** an agent working the `forge-plugin` project, speaking in a room belonging to
  this one. It holds no handle row in that conversation.
- **What breaks if they drift:** judge agency by room membership and the cross-repo exchange — the
  exact case the loop breaker exists to judge — reads as human traffic and is never cut. And the
  breaker cuts on repeated identifiers rather than on a message count precisely because two agents
  settling a cross-repo change trade many messages and every one of them carries something new;
  `proactivity.test.ts` holds that case.
- **How you would notice:** the tests hold the shape. Nothing notices a real cross-repo exchange
  being mis-scored in production.

---

## The body and component vocabulary

### `forge-*` component markup is refused by name

- **This side:** `validate.ts:refuseComponent` throws `BodyInvalidError` naming the element and the
  removal date, rather than unwrapping the tag the way an unknown tag is unwrapped. Held at three
  doors: `prepare.test.ts` and `forge-comments-body.test.ts`.
- **The other side:** plugin skills, which still carry the vocabulary and reach these doors over
  the wire. *Unverified from this repo* — which skill still emits it is not readable here.
- **What breaks if they drift:** the component set was removed on 2026-09-14. Unwrap instead of
  refusing and a skill's structured record — one block per acceptance criterion, the reading it
  meant — is silently flattened into prose behind a 200 and a warning nobody reads. Refusal by name
  is the only outcome the caller can act on.
- **How you would notice:** the caller does, because it gets a 400 naming the element. Nothing here
  notices how many callers are still sending it.

### The comment body cap is the published client contract

- **This side:** `body-input.ts:COMMENT_BODY_MAX_CHARS` (64,000) to `body-input.ts:commentBodyField`
  to `forge-comments.ts`'s `body` field, published as `data.body.maxLength` by
  `lib.ts:toolInputSchema`. One number for every comment body, not a tier per record kind: a
  34-criterion typed verdict measures around 48,000 characters, and a client that must know its
  tier before it can refuse cannot refuse before it uploads evidence it cannot take back.
- **The other side:** the plugin reads that `maxLength` off the tool schema. *Unverified from this
  repo.*
- **What breaks if they drift:** restate the literal at the MCP door instead of importing the
  constant and the two numbers diverge, which is the state ISS-958 found them in: the cap a client
  reads and the cap the REST routes enforce become different numbers, and the client refuses or
  permits against the wrong one.
- **How you would notice:** nothing notices the drift itself. The import is the guard —
  `forge-comments.ts` takes `commentBodyField` from `body-input.ts` and declares no literal.

---

## The release-flow skill

### The name `release-flow`

- **This side:** `plan.ts:RELEASE_BATCH_SKILL`. One constant, because the job's `skillName` and the
  invocation line in the prompt are the same claim about the same run: `prompt.ts:renderMethod`
  renders it into the prompt and `service.ts:insertAndEnqueueJob` stamps it on the job. It
  previously stamped `release-flow` while the prompt said nothing about it, so the column selected
  nothing while reading like a designation.
- **The other side:** `plugin/skills/release-flow`, reaching a box through its plugin designation.
- **What breaks if they drift:** renaming it here reaches an agent only when the plugin says the
  same word. Until then the invocation finds nothing.
- **How you would notice:** nothing notices a rename landing on one side. `prompt.test.ts` asserts
  the prompt contains the CONSTANT rather than the string, so the two in-repo copies cannot
  diverge; the third copy is in the other repo.

### The unloaded-method amnesty

- **This side:** `method.ts:assertMethodFor`. A `null` announcement is refused and a MISMATCH is
  refused — a run announcing some other skill is a run working from a method nobody chose for it.
  An announcement whose `loaded` is FALSE **passes**, deliberately and temporarily, priced as
  `cm:hack ISS-1042 until:forge-plugin ISS-1521 ships plugin/skills/release-flow`, which is one of
  the seven `cm:hack` annotations this repo still carries. Held by `method.test.ts`,
  `prompt.test.ts` and `release-ledger-e2e.test.ts`.
- **The other side:** `plugin/skills/release-flow`, which does not exist yet. **Verified at the
  pin, and this is the one negative the artifact can prove**: `plugin/skills/` at that ref holds
  `audit-code-quality`, `dispatch`, `forge`, `gate-review`, `harness-eval`, `issue-flow`,
  `setup-code-quality` and `vi-natural`, and the string `release-flow` appears nowhere under
  `plugin/`. The fleet's own copies are still unverified from here.
- **What breaks if they drift:** refusing an unloaded method blocks every run that announces
  `loaded: false`. At the pin that is every run, because `release-flow` is not in the artifact at
  all; how many boxes on the fleet carry a newer plugin that does load it has not been measured
  from here, so read this as a claim about the pin rather than about the fleet. The cost of the
  amnesty is that a run with no method is visible rather than blocked — it is recorded and
  readable as one that ran without a method, and the refusal is one predicate away.
- **How you would notice:** the ledger holds it: the announcement row carries `loaded: false` with
  its detail. Removing the amnesty reds a test that states what the trade was, which is the
  intended tripwire when the skill ships.

---

## The chat door's verb list

### `jobs.ba.verbs`

- **This side:** `forge-cli-argv.ts:CHAT_JOB_VERBS` — `issue`, `new`, `comment`, `attach`, `next`,
  `spec`, `guide`, `project`, `knowledge` — enforced by `forge-cli-argv.ts:admitVerb` and written
  into the per-turn config by `forge-cli-argv.ts:chatWithheld`. `forge knowledge` narrows further
  to the reads (`list`, `get`, `search`); `write` and `delete` are a run's, not a room's.
- **The other side:** the `jobs.ba` entry in the plugin repo's own `.forge.json`, which is the
  SOURCE of this list. **Verified at the pin**: the same nine, in the same order. The repo's live
  `.forge.json` is unverified from here.
- **What breaks if they drift:** a verb added there is one chat still refuses; a verb removed there
  is one chat still offers. A chat door has no checkout to read the file from, which is why the
  list is copied rather than resolved.
- **How you would notice:** nothing notices. `admitVerb` refuses an unlisted verb with a message
  naming what is open, so a newly added plugin verb fails as though it never existed. Note the
  asymmetry the door depends on: `withheld` in the CLI's config HIDES a verb from `forge -h` and
  does not refuse it at run, so `CHAT_JOB_VERBS` is written to the config for what the model is
  SHOWN and checked in `admitVerb` for what it may RUN. The credential's permissions are the fence
  under both.

### The CLI entry point the chat door executes

- **This side:** `forge-cli.ts:bundledCli` resolves `forge-plugin/package.json` through
  `createRequire` and runs `plugin/src/cli.mjs` with this process's own node — never a `forge` on
  PATH (the container has none), and never through a shell: `forge-cli.ts:run` uses `execFile` with
  an argv array, because the model composes those arguments.
- **The other side:** `plugin/bin/forge` and `plugin/src/cli.mjs`. **Verified at the pin**:
  `plugin/src/cli.mjs` is the entry `bin/forge` execs. The wrapper is slightly more than the
  annotations said — it resolves symlinks first and, when reached THROUGH a symlink, execs
  `src/dispatch.mjs src/cli.mjs` instead; the direct-invocation branch is the one this door
  reproduces.
- **What breaks if they drift:** calling the entry directly is what makes this the same CLI at the
  same pinned SHA the shape reader already comes from. If the plugin moves its entry, `bundledCli`
  resolves a path that does not exist and every chat CLI call fails; `FORGE_CLI_PATH` is the only
  override.
- **How you would notice:** loudly, at the first call — but as an exec failure, not as a named
  refusal. Two adjacent settings exist because a silent failure was worse: the 180s timeout is
  reported on stderr rather than returned as an empty exit 1 (measured 2026-09-15 — with the
  tracker answering in 9s per call, a 60s cap fired and the model read "rejected without an error
  message"), and the 200,000-character output cap is sized so the model reads the WHOLE of what the
  CLI said.

### The typings for a plugin that ships plain `.mjs`

- **This side:** the triple-slash reference to `forge-plugin-visibility.d.ts` at the head of
  `forge-cli-argv.ts`, and that declaration file, which declares `VERB_NAMES` and `withheldForJob`
  for the module `forge-plugin/plugin/src/resolve/visibility.mjs`. That file DESCRIBES and never
  decides: a name added there that the plugin does not export is the server inventing a verb.
- **The other side:** `plugin/src/resolve/visibility.mjs`. **Verified at the pin**:
  `withheldForJob` is exported.
- **What breaks if they drift:** the reference line is what carries the declaration into every
  program that compiles this file. `@forge/contracts` builds core under a tsconfig whose `include`
  is its own `src/**`, so without the line the import falls to TS7016 there — a build failure in a
  different package than the one edited. If the plugin renames the export, the declaration lies and
  the failure moves to runtime.
- **How you would notice:** the TS7016 half is caught by the build. The "declaration no longer
  matches the plugin" half is caught by nothing: the module is plain `.mjs`, so nothing typechecks
  the declaration against it.

---

## Where forge-plugin is the tenant being measured, not the other half

These two carry no second half to keep in step. They are recorded because the evidence behind the
rule was measured on the `forge-plugin` project's own rows, and a later reader re-measuring on this
project alone will not reproduce it.

### The two non-ship exits from the release gate

- **This side:** `merged-at.ts:markMergedIfLeavingBase`. Leaving `merged-at.ts:BASE_MERGE_STATE`
  (`awaiting_release`) stamps `merged_at`, except for two targets that are not ships: `releasing`
  is the release STARTING — stamp there and the claim itself marks every issue shipped, so an abort
  leaves `merged_at` set on work that never released; `dropped` is the release ABANDONED, and
  `dropped` exists precisely to end an issue without the stamp. The stamp belongs to
  `releasing -> closed`, where `finish` has read the deploy back.
- **The other side:** none in code. The incident is on the other project's rows: measured
  2026-09-10 on a forge-plugin issue — dropped from the gate, `merged_at` set, nothing shipped.
  *Unverified from this repo*, because that row is on the `forge-plugin` project.
- **What breaks if they drift:** `merged_at` is what unblocks every `blocks` dependent, and nothing
  server-side checks git. A wrong stamp unblocks dependents as if the work had landed.
- **How you would notice:** nothing notices. `markMergedIfLeavingBase` is idempotent and silent,
  and the dependents simply dispatch.

### The reranker is shown the text that matched

- **This side:** `rerank.ts:shownText` returns the matched chunk's text where there is one and the
  whole row otherwise, and the cache key hashes the same string.
- **The other side:** none in code. The measurement that fixed it spans both projects: showing the
  row head on a chunked project demoted the exact-passage hit out of the top 8 in 2 of 4 live
  passes on forge-dev, and moved it 1 to 4 and 1 to 5 **on forge-plugin** (2026-09-05), because a
  75,000-character issue was judged by its first paragraph while the query matched passage 76.
- **What breaks if they drift:** the model ranks a passage it was never shown, and the regression is
  a quiet quality loss with no error anywhere.
- **How you would notice:** only through the pilot's own instrument — `rerank.ts:inRerankHoldout`
  draws a control group per search so confirmed-feedback rates of reranked rows can be compared
  against holdout rows. A holdout drawn on ineligible calls, or skipped on eligible ones, leaves
  the flag with no control group and this signal with nothing behind it.

---

## Where forge-plugin is a dependency of this repo's own build

### The marketplace name a runner must not take

- **This side:** `plugin_sync.rs:classify_known` and its `Foreign` arm — a directory the operator
  registered under the name this repo's `marketplace.json` claims is theirs, and the runner leaves
  it.
- **The other side:** the name the forge-plugin clone's own `marketplace.json` claims. *Unverified
  from this repo* — that file is not in the pinned npm artifact's layout.
- **What breaks if they drift:** `claude plugin marketplace add` silently REPLACES a same-name
  marketplace. On dev1, 2026-09-03, the operator's `forge-local` at `~/tools/forge-plugin` became
  the runner's clone. Check the name our clone claims BEFORE adding; an operator's directory under
  that name outranks the server, the same way a local target outranks a server one in
  `plugin_sync.rs:merge_targets`.
- **How you would notice:** nothing notices — the replacement is silent, which is the whole reason
  the classification exists.

### The pinned forge-plugin resolution in the lockfile

- **This side:** `lockfile-transport.mjs:SSH_FORMS`, run by `scripts/check-lockfile-transport.mjs`
  and declared in `verify.mjs` as the `lockfile-transport` check. It scans the lockfile text rather
  than parsing it, because it runs before `pnpm install` and must not need a YAML library. Its two
  lookaheads are what keep the lockfile's own rows out: `//` after the colon is a URL scheme, so
  the `codeload` entry is the shipped one and not a host called `https`.
- **The other side:** the forge-plugin tarball entry itself, in `packages/core/package.json` and
  `pnpm-lock.yaml`. Verified in this tree.
- **What breaks if they drift:** a Dependabot pull request rewrote `forge-plugin`'s resolution to
  `git@github.com:` and took all six installing jobs down inside `pnpm install` with exit 128,
  unnamed for two days (ISS-1045). This CI is never given an SSH key, and a Dependabot-triggered
  workflow is never given a repository secret. Narrow the lookaheads and the check starts refusing
  the shipped entry; widen the SSH forms wrongly and it stops catching the entry that kills the
  install.
- **How you would notice:** this check is the notice, and it is the one check that runs where no
  other can — `.github/actions/setup-workspace` calls it BEFORE `pnpm install`. It declares no
  conformance axis and adds no job to `ci-passed`, so nothing in `.forge/conformance.json` or
  `conformance-status.mjs` moves with it.

### A symbol cited from the plugin must not be gated as a local anchor

- **This side:** `check-memory-anchors.mjs:citedSymbols`. A backticked symbol is only treated as a
  claim about THIS repo when the same line also carries a repo path. Never a `*.ts`-shaped filename
  test: gating anything looser produced 21 findings of which 17 were noise (measured 2026-09-12).
- **The other side:** the plugin's own source files, which this project cites by name and reaches
  by issue and never by checkout.
- **What breaks if they drift:** a loose filename test gates a symbol that lives in a repo this
  checkout does not contain, and the anchor check reds on a correct citation of the other repo.
- **How you would notice:** as false findings from the anchor check — noisy rather than silent,
  which is why this one is the easiest of the set to get wrong in the safe direction.

---

## Dropped as unverifiable

Each of these was carried by an annotation, checked, and found to name something that is not there.
None of them is in the record above.

- **`pipelineConfig.plugins`**, named by the `AUTONOMOUS_SKILL_NAME` annotation and by `CLAUDE.md`
  — no `plugins` key exists in `pipeline-config-schema.ts`. The designation is stored at
  `projects.agent_config.plugins` and read by `plugins/designation.ts:readPluginDesignations`,
  unioned across a device's projects at `GET /api/devices/me/plugins`. The coupling is carried
  above with the corrected key; the name `pipelineConfig.plugins` is not.
- **`markedCommit` in the plugin's `src/flow/machine.mjs`** — at the pin the symbol is exported
  from `plugin/src/flow/record/merged.mjs`, not `machine.mjs`. The rule it illustrates is carried;
  the path is not.
- **"the skill's status table" in `plugin/skills/issue-flow/SKILL.md`** — the pinned `SKILL.md` is
  front matter plus one paragraph saying the method is served by the CLI, with no status table.
  Whether the live repo's `SKILL.md` carries one cannot be checked from here.
- **`plugin/bin/forge` "whose whole job is `exec node src/cli.mjs`"** — at the pin the wrapper also
  resolves symlinks and, when invoked through one, execs `src/dispatch.mjs src/cli.mjs` instead.
  Carried above with the description narrowed to the branch this door reproduces.

Two annotation claims about things that no longer exist were checked and are **confirmations, not
failures**: `scripts/check-autonomous-transitions.mjs` is absent from `scripts/`, as the
`AUTONOMOUS_DRIVER_STATUSES` annotation said it would be; and there is no `is_ai` column in
`db/schema.ts`, as the `authorDeviceId` annotation said.
