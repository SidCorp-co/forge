# A fact declares when it applies, and something checks it is still true

**Status:** proposed, nothing implemented. **Verified against the tree:** 2026-09-17, after ISS-1048
moved project prose out of `agentConfig.projectFacts` into `knowledge_entries` and ISS-1068 retired
the UX Contract subsystem. The store changed and this proposal's first worked example was settled
without it; the gap this proposal is about did not change, and the names below are the current ones.

A knowledge entry is delivered on exactly two settings that reach a prompt — `injection: always`
(verbatim in every prompt) or `injection: on_demand` (a slug in a fetch-on-demand index); the third,
`none`, reaches no prompt at all. None of them carries the one thing most entries already state in
their own prose: **when they apply.**

## Measured

The case that opened this proposal has since been settled the blunt way, and it is worth recording
what it cost. `ux-contract` on forge-dev was 4,116 characters at `injection: always`, opening with:

> BINDING for any issue that adds/changes UI in `packages/web-v2/`.

9 of the last 40 commits on `main` touch `packages/web-v2/`, so **~78% of prompts carried a 4 KB UI
checklist that its own first line said did not apply to them.** ISS-1068 did not teach the system to
read that declaration — it moved all 13 `ux-contract` entries to `injection: on_demand` outright, so
the waste is gone and so is the guarantee. That is this proposal's own trade taken without its
design, on one entry, by hand.

**The gap itself is untouched.** No entry can declare when it applies, and the next entry that needs
the distinction gets the same two bad choices. The live case is the other direction: ISS-919 merged a change under `packages/runner/**`
and cut `runner-v0.12.0`. It did so because that issue's own comment happened to say "Ships as
`runner-v0.12.0`". No skill names `tag`, `runner-v` or `cargo`; no fact covers release artifacts.
The next runner change with no such sentence merges with no tag and **nothing reports the absence**
— `deploy-policy` covers Coolify and answers, so the project reads as configured.

## What exists, verified

| Anchor | Fact |
|---|---|
| `prompt/system.ts` → `buildPipelinePreambleStructured` | builds the preamble; `forge-facts` is one section, after `project-context`, before the state block |
| `prompt/facts/resolve.ts` → `loadProjectFactInputs`, `renderStageFactsText` | resolves `alwaysInjectFacts` + `projectFactKeys` from `knowledge_entries` and renders the block |
| `BuildPreambleOptions` | `{ step, override, mcpDiagnostics }` — **no issue, no branch, no diff** |
| `projects/autonomous-contract.ts` → `requiredProjectKnowledge` | computes `{slug, role, because}` from what the project declares; `missingProjectKnowledge` is what settings and the prompt both read |
| three comments in `system.ts` | the layer order is cache-motivated: the shared prefix must stay "the longest common cacheable span" |

The rationale above the facts block states the existing intent, and it is the constraint this
proposal must not break: facts are injected at preamble build **rather than copied into skill
bodies**, so a skill stays pure business logic and current without re-syncing every skill file.

## Ruled out: core evaluates the condition at dispatch

The obvious shape — a `when: { pathsChanged: ["packages/runner/**"] }` beside the entry's
`injection`, evaluated by core when it builds the preamble — **does not work, and the reason is not
cost.**

At `drive` dispatch the branch does not exist yet; the agent creates it. Core has no checkout and
no diff, so on the pass where the fact matters most the condition is unknowable. Threading the
issue into `BuildPreambleOptions` does not fix that: the data is absent, not unplumbed.

Rejecting it also protects the cache layering, which would otherwise have to be re-argued: the
`forge-facts` block currently varies per `step`, and making it vary per *change* would push the
first varying byte earlier and cost the state block its shared prefix.

## Design

**1. A fact declares applicability as data; the agent evaluates it.**

`applies` replaces two booleans rather than joining them:

| today | becomes |
|---|---|
| `knowledge_entries.injection: 'always'` | `applies: always` |
| `knowledge_entries.injection: 'on_demand'` | `applies: on_demand` |
| `knowledge_entries.injection: 'none'` | `applies: never` |
| a slug `requiredProjectKnowledge` computes | unchanged — the contract stays a function of what the project declares |
| — (new) | `applies: { pathsChanged: [glob] }` |

A `pathsChanged` fact is **not** injected as a body. Core renders one line into the on-demand
index, carrying the condition verbatim: *"`release-artifacts` — read before you finish if your
change touches `packages/runner/**`."* The agent holds the diff, so it is the only party that can
evaluate the condition, and it evaluates data rather than inferring intent from prose.

Cost on forge-dev: **the measure of this change is that total injected text goes down.** If it does
not, the change has failed regardless of what it enabled. The 4 KB that `ux-contract` used to
contribute is already off the always tier (ISS-1068), so the baseline this is measured against is
the one that change left, not the one this proposal was written over.

**2. The condition language is globs on changed paths. Nothing else.**

Priced: conditions that are not paths — "only for bug issues", "only when there is a migration" —
cannot be expressed and must wait or be solved elsewhere. Bought: no predicate mini-language that
nobody can read in six months. Both conditions we actually need today are paths.

**3. Absence becomes a state, not a blank.**

The contract gains a third answer: declared · **deliberately none** (`applies: never` + a reason) ·
unanswered. Today forge-dev is in the third state for release artifacts and nothing
shows it, which is exactly why "will it cut the tag" had no answer. A default would be worse than
either: it looks answered.

**4. A rule lands next to the command it governs.**

Facts are written with the rule inline at the invocation it constrains, not as a prose block above
a list of commands. `test-commands` (5 KB of interleaved prose and tables) is the first rewrite.

**5. The atoms in a fact are checked against the tree.**

A gate extracts every command and path a fact names — `pnpm <script>`, `scripts/*.mjs`,
`.forge/*` — and resolves them against `package.json` and the filesystem. A fact naming a script
that no longer exists fails the gate, named.

Measured 2026-09-06, against the same bodies before they moved store: **31 of 31 atoms in
forge-dev's facts resolve.** The gate starts green, so it
carries no backlog, and it will never be cheaper to add.

For projects whose repo Forge does not own, the same check runs as the driver's own preflight and
is reported on the issue under the existing change-contract rule (report the problem, keep going).
The asymmetry is deliberate: a gate needs control of CI, and where that is absent a run-time report
still beats silence.

## Open question, and it is the load-bearing one

**Does a triggered fetch get fetched?** The always-inject tier (ISS-521) exists because the
on-demand index alone was not enough. This design puts a body back on the index with a condition
attached and assumes a stated trigger changes that outcome. That assumption is untested — but it
stopped being hypothetical on 2026-09-17, because ISS-1068 put 13 `ux-contract` entries onto the
on-demand index with no condition at all.

So measure it on what is already running rather than waiting for this proposal to ship: for the
first N issues after that change, check whether an agent whose diff touched `packages/web-v2/`
fetched `ux-contract` by slug. A fetch rate near zero there is evidence about the index itself and
argues that a bare slug is not enough; a healthy rate is the weaker claim this design needs, since a
condition line says more than a slug does. If the answer is bad, the answer is not to revert to
`injection: always` for everything — it is that `applies` needs a fourth value meaning "inject the
body, but only on the steps where the condition can already be evaluated" (`review`, `test`, `fix`
all run against an existing branch).

## Honest costs

| What it costs | Paid by |
|---|---|
| **A guarantee becomes a hope.** `injection: always` is unmissable; a trigger line is not. Whatever is traded away will now reach an agent that chose to read it. If the open question resolves badly the cost is a second round of design, not a revert: reverting everything to `injection: always` restores the waste | every project relying on an injected rule being unmissable |
| **A silent migration failure.** Every entry on the always tier must move to `applies`, and an entry that lands on the wrong value fails silently in the direction nobody looks. Precedent, same surface: the UX contract's recompile never SET the always-inject flag, so `qa-project` ran 22 compiled rules dark from 2026-08-11 until somebody noticed. Verification means reading a rendered prompt per project, not trusting the writer | whoever runs the migration, once per project |
| **A stale glob fails open and nothing catches it.** The atom gate reads commands and paths *inside* a body, never the glob in `applies`. Rename `packages/web-v2/` and the fact silently stops firing, which looks exactly like a project that correctly has no such rule. This proposal opens that hole one level up from the one it closes | the next person to move a directory |
| **A judgement fact authors did not have.** Writing a fact now means choosing an applicability and keeping it true as the repo moves. One boolean had no way to be subtly wrong | every fact author, on every fact, forever |
| **A fact may no longer name a command that does not exist yet.** The procedure and the script it calls must land in the same change | whoever wants to write the runbook first |

## Deletes

- The three-valued `injection` column — replaced by `applies`, not stacked beside it.
- `build-test-commands` on forge-dev — already documented in its own body as vestigial.

## Not in this proposal

- Fact health measured on the runner box and surfaced in the UI — a new plane for a failure that
  has not happened; the driver's preflight report covers it.
- Anything about where an entry is stored. ISS-1048 settled that: `knowledge_entries`, one typed
  store with one door. Moving procedures into repo files instead would let a declared edge name
  them, which is attractive and is a separate argument — Forge is a control plane for ~40 repos it
  mostly does not own.
