# Release gate & deploy — closing the autonomous pipeline

- Status: **Draft (owner session 2026-08-24)** — design agreed in-session, not implemented.
- Visual: [mockups/release-flow.html](mockups/release-flow.html) — open in a browser.
- Related: [agent-driven-pipeline.md](agent-driven-pipeline.md) (the mode this completes) · [../integrations/framework.md](../integrations/framework.md) (the model the deploy layer reuses) · [RFC 0002](../rfcs/0002-park-axis-separation.md)

## Summary

The autonomous driver ends an issue by merging to the base branch and **closing it**. Nothing
between "code is on `dev`" and "it shipped" exists, so `done` claims a thing that did not happen,
and every human gate the project configured is inert. This proposal adds the missing half: an
issue ends at a **release gate**, and only a release — batched, scheduled or hand-picked — writes
`done`, after an independent probe proves the deployed thing carries the merged commit.

It is deliberately not a patch. The autonomous mode is finished by this, or it ships a pipeline
whose terminal state is a claim nobody verified.

## What is measured today (2026-08-24, forge-beta)

| Fact | Evidence |
|---|---|
| The agent closes its own issue with nothing shipped | epodsystem ISS-141: drive job `done` 07:12Z → merged `02ec026` → self-closed 08:47Z → human reopened 08:52Z because the bug was still live |
| Every stage gate is dead on an autonomous project | `pipeline/orchestrator.ts:495` returns before `:501` `enabled===false`, `:502` `mode==='manual'`, `:503` step toggles. Three human gates unreachable |
| The skill promises a gate the kernel does not have | `forge-drive/SKILL.md`: *"the cloud … blocks exactly two things: deploy and close"*. `isAutonomous` is consumed in exactly 3 places (dispatch, answer-resume, one short-circuit). There is no close gate and no deploy gate |
| `reopen` is a silent black hole | `autonomousStepFor` returns a step for `open` only; `answer-resume` covers `needs_info` only; `issue-vocabulary.ts:55` renders `reopen` as **`running`**; the reconciler re-dispatches it every 60s into a no-op and counts each as `rescued`. ISS-141 sat there 60+ minutes |
| The batch release exists but is wired to the staged vocabulary | `release-batch/gate.ts` keys the gate on `states.tested.mode === 'manual'`; autonomous never reaches `tested` |
| The batch release can land on a box that cannot deploy | `release-batch/service.ts:123` calls `selectRunnerForJob({projectId, requiredCapabilities:{}})` — no `allowDeviceIds` |
| The release procedure is hardcoded for one provider | `prompt/state-prompts/release-batch.ts` writes merge-prod → Coolify → one `[Unreleased]` line. epodsystem has no Coolify, needs a no-squash MR + tag, and promotes a version section |
| The resume point is not being used | 76 `drive` jobs `done` fleet-wide; **1** has any `phase_journal` row |

## Target state

See the diagram. In words: `open` → one drive session (7 phases) → phase 6 merges to base and stamps
`merged_at` → phase 7 writes the changelog line and lands the issue at **`awaiting_release`** → a batch
(cron, hand-picked, or single) cuts the version, merges production, deploys through the project's
channel, and **verifies**; `finish` is the only writer of `done`.

Seven labels; each exists only because the kernel enforces something (the admission rule from the
parent proposal). The only new one is the gate, and what it enforces is: *nothing but the release
path may close an issue from here.*

## Where per-project knowledge lives — three layers

| Layer | Shape | Home | Why there |
|---|---|---|---|
| ① Channel | typed, closed set | `integration_bindings.provider` (`coolify` · `ci` · `agent` · `none`) + `environment='production'` | the kernel must know whether a deploy step exists and which box may run it. `provider` is `text`, not an enum → adding a channel is zero migration |
| ② Procedure | free prose | `binding.instructions` (already injected verbatim into agent prompts, with a `cm:guard` forbidding credentials) + `projectFacts.release-procedure` for the repo-side ritual | the tail is infinite: *"frontend must ship with varnish or the director goes SICK"*, *"run `crm-indexer reindex --type=content` once after deploying 1.12.0"*. No schema holds that |
| ③ Proof | typed, required when channel ≠ `none` | `binding.config.verify` | "deployed" must not be an agent's sentence. Same principle as the review verdict being runner-written — precedent: `phase_journal_verdict_is_runner_written` |

## The work

### L0 — kernel truths (no release path needed to be correct)

| # | Change | Where | Acceptance |
|---|---|---|---|
| L0.1 | Phase 6 calls `forge_issues mark_merged {target:'base'}`; phase 7 exits to the gate status, never `closed` | `packages/runner/skills/forge-ship/SKILL.md` | an autonomous issue that merged sits at the gate with `merged_at` stamped at merge time |
| L0.2 | Close gate: reject `→ closed` when the actor is an agent, the project is autonomous, and the issue is at the gate; answer names the release path | `issues/apply-transition.ts` | L0.1 is enforced, not requested. A skill edit cannot re-open the hole |
| L0.3 | Label map: gate → `awaiting_release`; `reopen` → `open` (today: `running`) | `contracts/issue-vocabulary.ts` | no board cell reads "running" while no session exists |
| L0.4 | Normalize `reopen` on autonomous projects: increment `reopen_count`, write the `🔁 Reopened from X` comment, then land at `open` | `issues/apply-transition.ts`, same write-time-rewrite shape as `issues/intake-gate.ts` | a reopened issue dispatches a drive job; the reconciler no-op loop disappears; the quality signal survives |
| L0.5 | Move the three gate checks above `dispatchAutonomous` | `pipeline/orchestrator.ts:495` ↔ `:501-503` | `states.open.mode='manual'` blocks the drive dispatch; Skip and the step toggles stop being dead knobs |
| L0.6 | Make the phase declaration real: `forge-drive` must call `forge_phase` before each phase, and the runner must fail the turn loudly when it did not | `packages/runner/skills/forge-drive/SKILL.md` + runner | > 1 in 76 drive jobs carries a journal; a session that dies resumes instead of restarting |

### L1 — the release path

| # | Change | Where | Acceptance |
|---|---|---|---|
| L1.1 | Gate resolver understands autonomous instead of inferring from `states.tested.mode` | `release-batch/gate.ts` | an autonomous project has a gate without pretending to hold a staged config |
| L1.2 | Split protocol from procedure: keep `get → … → finish/abort` hard in the state prompt; move merge/version/changelog/deploy steps to `projectFacts.release-procedure` + `binding.instructions` | `prompt/state-prompts/release-batch.ts` | epodsystem cuts with `release.sh` (no-squash + tag) without a code change; a claim can never leak because the protocol stayed |
| L1.3 | Release runner pool: resolve device ids from a **label** on the production binding, pass as `allowDeviceIds`, and refuse to start (`NoRunnerOnlineError`) when the pool is empty — never fall back to the fleet | `release-batch/service.ts:123` | a release job cannot land on a box without the deploy credential; a rebuilt box keeps working because the label, not the uuid, is the key |
| L1.4 | Roster query: issues at the gate, with age since `merged_at` | `release-batch/routes.ts` | "12 issues waiting, oldest 6 days" is a query, not a notification |

### L2 — deploy and proof

| # | Change | Acceptance |
|---|---|---|
| L2.1 | `forge_coolify_deploy` → `forge_deploy`, routed by `provider`, keeping Coolify's semantics (target fan-out, run-tracked, prod gated to the release stage) | a second channel does not create a second tool with its own lifecycle |
| L2.2 | `verify` contract on the production binding: **list** of probes, cache-bypass required, green only when `commit(live) == commit(merged)`, plus timeout and consecutive-stable-reads | a healthy site still serving the old build reads as **red**, which is the common deploy failure |
| L2.3 | Channel `agent`: the session runs the project's own deploy script on a pinned box. Forge orchestrates and verifies; the mechanism stays in the project repo | no ssh engine, no prod keys, in Forge |
| L2.4 | Rollback, declared per project. Applies **only** to "deployed and the app died"; never to "the deploy never came up" (the old build is still serving). At most once. A rollback `abort`s the batch — it never `finish`es it | a dead site is recovered in seconds; a rolled-back release never reports as shipped |

### L3 — automation and visibility

| # | Change | Acceptance |
|---|---|---|
| L3.1 | Schedule kind that calls batch-create per project (cron) | the cut runs unattended and `abort`s safely |
| L3.2 | Issue UI: `awaiting_release` badge, *"merged into `dev` N days ago"*, **countdown to the next batch**, `Release now` | a person reading an issue knows when it ships without asking |
| L3.3 | Release tab: next-batch roster, last cut (version, issues, result), **which boxes can release**, cut-now with selection | the release state is legible without a DB query |

The countdown must degrade honestly: no schedule → *"no schedule — waiting for a person"*, never a
fake countdown; last batch failed → show the failure instead of counting toward a run that will fail
identically. Every number derives from `merged_at` + the cron.

## Rollout — no half state

The gate is **per project**, and a project either has the whole path or none of it. L0.1/L0.2 change
the terminal behaviour of every autonomous project at once (kinetrak, apiflow, getcontent,
epodsystem), so they are gated on the project declaring a release config. A project without one keeps
today's behaviour until it opts in; a project with one gets the gate, the batch, the schedule and the
UI together. There is no window where issues stop closing and nothing can release them.

Order: L0 → L1 → (L2 ∥ L3.1) → L3.2/3.3. L2.2 blocks nothing except channels other than `none`.

## Invariants

1. **One writer of `done`** — `release_batch finish`. Enforced by L0.2, not by skill prose.
2. **A gate the kernel does not enforce is decoration** — the lesson of `mode:'manual'`.
3. **`merged_at` means "on the base branch"**, stamped at merge, not at close.
4. **Verify is a probe, not an opinion.**
5. **Rollback never finishes a batch**, and never runs when the previous build is still serving.
6. **No notification may become a mute switch** — every release number is derivable from data.
7. **No second reaper, no second scheduler, no second config tree** — reuse `integration_bindings`, `forge_schedules`, the existing dispatcher.

## Not doing

An ssh deploy engine inside Forge (blast radius: one bug = N production hosts; the project's script is
already reviewed and versioned) · a new scheduler · a `pipelineConfig.deploy` tree parallel to the
integration model · per-project forks of the autonomous skills (the mode forbids it by design) ·
auto-rollback by default · a new kernel status for the gate (the label layer covers it).

## Project-side prerequisites (epodsystem, not Forge)

1. A `{version, commit}` echo endpoint — extending `/api/health`'s body is safe, the varnish `fe_probe`
   only reads the status code. Without it, verify cannot tell "healthy" from "healthy on the old build".
2. Images tagged per version instead of relying on a rebuild from source. Then rollback is
   `docker compose up -d` at the previous tag — seconds, no build — and **deploy and rollback become
   the same operation with a different tag**, which means the rollback path is exercised on every
   release rather than only during an outage.
3. A box carrying the prod ssh credential, labelled for the release pool.

Until 1–3 exist, epodsystem runs `provider: none`: the batch cuts the version and stops, and the human
deploys — which is today's arrangement, made explicit rather than implicit.

## Open decisions

Resolved in-session and recorded as D1/D2/D3 in the checklist below; the only one still open is
where a project declares it has a release path at all — a production `integration_binding` alone,
or an explicit `pipelineConfig.release.enabled` flag. L1.1 decides it, and nothing before L1.1
depends on the answer.

Settled earlier and assumed throughout: the production credential lives on the runner box, not in
Forge `secretsEnc` — L1.3 is derived from that.

## Implementation checklist

Verified against the tree on 2026-08-24; every anchor below was read, not recalled. `pnpm verify`
green is part of every box and is not repeated per line. Order is dependency-derived and **differs
from the section order above**: L1.1 moves ahead of L0.1/L0.2, because *"does this project have a
release gate"* is the condition those two are gated on, and the resolver is what answers it.

### Decisions taken — reverse them here if wrong

| # | Decision | Consequence |
|---|---|---|
| D1 | Gate status = the existing `tested` kernel status, renamed at the label layer | no enum value, no migration, no new reaper |
| D2 | epodsystem cuts **manually** until its `{version, commit}` echo exists; L3.1's cron is wired but left unscheduled for it, `provider: none` | the batch cuts the version and stops; the human deploys, as today |
| D3 | The release-pool key is `binding.config.releaseRunnerLabel`, matched against `runners.labels` | **not** `integration_bindings.label` — that column is the multi-store slug (`schema.ts:2853`) and sits inside `integration_bindings_project_provider_env_label_uq` |

### Wave 1 — kernel truths · no terminal behaviour changes, ship in any order

- [ ] **L0.3 · label map.** `packages/contracts/src/issue-vocabulary.ts`: add a 7th label
  `awaiting_release`; `LABEL_TO_KERNEL.awaiting_release = 'tested'`; `KERNEL_TO_LABEL.tested` →
  `awaiting_release`; `KERNEL_TO_LABEL.reopen` → `open` (line 55, today `running`). The module
  header says "six" and why — it must say seven and why, or it becomes the next stale claim.
  **Done when** no board cell reads `running` for an issue with no session.
- [ ] **L0.4 · `reopen` normalization.** `issues/apply-transition.ts`: on an autonomous project,
  rewrite `→ reopen` at write time to `→ open` while keeping the `reopen_count` increment and the
  `🔁 Reopened from X` comment. Same write-time-rewrite shape as `issues/intake-gate.ts`.
  **Done when** a reopened issue dispatches a drive job, and the reconciler's 60s
  `rescued++` no-op loop is gone. Regression test: ISS-141's exact sequence.
- [ ] **L0.5 · gate ordering.** `pipeline/orchestrator.ts`: move the three checks at `:501-503`
  (`enabled === false`, `mode === 'manual'`, step toggles) **above** the
  `dispatchAutonomous` return at `:495`. **Done when** `states.open.mode='manual'` blocks a drive
  dispatch — the thing the user configured and did not get.
- [ ] **L0.6 · real phase declaration.** `packages/runner/skills/forge-drive/SKILL.md` + the runner
  turn loop: `forge_phase` before each phase, and the runner **fails the turn loudly** when a phase
  ran undeclared. **Done when** the 1-in-76 journal ratio moves; measure again after 10 drive jobs
  before calling it done.

### Wave 2 — the gate · this is where terminal behaviour changes

- [ ] **L1.1 · gate resolver.** `release-batch/gate.ts:16-19` keys on `states.tested.mode` and
  returns `null` when it is `'auto'` — autonomous projects never write a `tested` config, so they
  read as *no gate*. Add: autonomous + a production `integration_binding` (or an explicit
  `pipelineConfig.release.enabled`) ⇒ gate is `'tested'`. Export one predicate
  (`hasReleaseGate(projectId)`) — L0.2 and L1.4 both consume it, and two copies of this condition is
  the bug.
- [ ] **L0.2 · close gate.** `issues/apply-transition.ts` (the same tx as `:252-266`): reject
  `→ closed` when the actor is an agent **and** `hasReleaseGate` **and** the issue is at the gate.
  The rejection names the release path. **Done when** an edited skill cannot re-open the hole —
  test it by asking an agent to close a gated issue and asserting the transition throws.
- [ ] **L0.1 · ship skill.** `packages/runner/skills/forge-ship/SKILL.md`: phase 6 calls
  `forge_issues action='mark_merged'` (the action already exists, `mcp/tools/forge-issues.ts:1200`);
  phase 7 exits to the gate, never `closed`. The current "## Close" block teaches the opposite and
  must go. **Done when** a merged autonomous issue sits at `awaiting_release` with `merged_at`
  stamped at merge time.

> Waves 1–2 land together per project. A project with no release config keeps today's behaviour —
> L0.2 no-ops for it — so there is no window where issues stop closing and nothing can release them.

### Wave 3 — the release path

- [ ] **L1.2 · protocol vs procedure.** `prompt/state-prompts/release-batch.ts`: keep
  `get → … → finish/abort` hard in the prompt; move merge/version/changelog/deploy to
  `projectFacts.release-procedure` + `binding.instructions`. **Done when** epodsystem cuts with its
  own `release.sh` (no-squash + tag) and no Forge code changed.
- [ ] **L1.3 · release runner pool.** `release-batch/service.ts:123` passes
  `requiredCapabilities:{}` and no pool. Resolve device ids by matching D3's label against
  `runners.labels` (`schema.ts:910`) and pass `allowDeviceIds` — `selectRunnerForJob` already
  takes it (`runners/select.ts:178`), so this is wiring, not new machinery. Empty pool ⇒
  `NoRunnerOnlineError`, **never** a fleet fallback. **Done when** a release job cannot land on a
  box without the deploy credential, and a rebuilt box keeps working because the label, not the
  uuid, is the key.
- [ ] **L1.4 · roster query.** `release-batch/routes.ts`: issues at the gate + age since
  `merged_at`. **Done when** "12 waiting, oldest 6 days" is a query, not a notification.

### Wave 4 — deploy and proof · only for projects whose channel is not `none`

- [ ] **L2.1** `forge_coolify_deploy` → `forge_deploy`, routed on `provider`, Coolify semantics kept.
- [ ] **L2.2** `verify` on the production binding: a **list** of probes, cache-bypass required,
  green only when `commit(live) == commit(merged)`, plus timeout + consecutive-stable-reads.
  **Done when** a healthy site still serving the old build reads **red**.
- [ ] **L2.3** channel `agent`: the session runs the project's own deploy script on a pinned box.
  No ssh engine and no production key inside Forge.
- [ ] **L2.4** rollback, declared per project, at most once, only for *deployed and the app died*,
  and it `abort`s the batch — never `finish`es it.

### Wave 5 — automation and visibility

- [ ] **L3.1** schedule kind calling batch-create per project.
- [ ] **L3.2** issue UI: `awaiting_release` badge, *"merged into `dev` N days ago"*, countdown,
  `Release now`. The countdown degrades honestly — no schedule prints *"no schedule — waiting for a
  person"*, never a fake number.
- [ ] **L3.3** release tab: next-batch roster, last cut, which boxes can release, cut-now.

### epodsystem, in parallel — not Forge work

- [ ] `{version, commit}` on `/api/health`'s body (varnish's `fe_probe` reads the status code only, so the body is free).
- [ ] Per-version image tags, so deploy and rollback become the same operation with a different tag.
- [ ] A box carrying the prod ssh credential, labelled for the release pool.
