# Skill Self-Evolution — Improvement Messages

How the **skill-improve loop** works: a central message registry broadcasts improvement
ideas; each project opts in and a per-project agent adapts each message to the project's
own context. Projects diverge on purpose — no global override, no homogenization.

**Prerequisites:** a Forge project with the pipeline enabled and project-admin access.

---

## The loop

```
Owner learns a practice → writes one MESSAGE to the registry (one commit)
                          ▼ broadcast (catalog visible to all projects)
          MESSAGE REGISTRY (global, git-versioned, source of ideas)
                          ▼ project enables it in Automation → Improve
SCHEDULE (cron) → skill-improve agent runs SEPARATELY per project
     ▼ reads: project skills · .forge/knowledge.json · forge_memory · recent runs
appliesWhen? ── no ──► skip (reason recorded)
     │ yes
     ▼ compose TAILORED skill edit — does NOT copy the global skill verbatim
mode=propose (default): create draft issue + diff → human reviews → applies
mode=auto   (opt-in):   forge_skills.update + push + report
     ▼
Project skills EVOLVE (diverge, fit-to-project) → new context on next run
```

Divergence between projects is the **goal**. A message that applies to one project may
be irrelevant (or already covered) in another; the agent judges and records why.

---

## Enabling messages for a project

1. Open **Automation → Improve** for your project.
2. The **Catalog** shows all registry messages. Each card shows title, rationale,
   category, and a **Recommended** badge (maintainer endorsement — not auto-enabled).
3. Toggle a message **on**. Pick:
   - **Mode** — `propose` (default): the agent files a draft issue with the proposed
     skill diff for human review. `auto` (opt-in): the agent updates the skill
     directly and reports the change.
   - **Cadence** — weekly/daily preset or a custom cron expression.
4. The active list shows `last run / next run / last outcome` (applied / proposed N /
   skipped N). Expand any run to see per-message results (proposed entries link to
   the draft issue).
5. **Run now** — manual trigger; available while no run is in flight.
6. Disabling a message stops future runs; the project's already-applied skill edits are
   kept (no rollback). Re-enabling re-queues the message for the next cadence.

---

## How the agent evaluates a message

On each scheduled run the agent executes five steps in order:

| Step | What it does |
|------|-------------|
| **1 — Read context** | Loads project skills (`scope=project`), `.forge/knowledge.json`, `forge_memory` (`knowledge`/`decision`/`fix-pattern`), and the 20 most-recent pipeline runs (looking for reopen/failure patterns). |
| **2 — Evaluate `appliesWhen`** | Reads project config (baseBranch, productionBranch, mergeStates, pipelineConfig, projectFacts) and judges whether the condition holds. Records its reasoning. If the condition is not met, goes directly to Step 5 with `status=skipped`. |
| **3 — Compose tailored improvement** | Reads the current target skill body and writes a **minimal, targeted** change that incorporates the message guidance in a way that fits the project's existing idiom and conventions. Does NOT wholesale-replace the skill. |
| **4 — Apply per mode** | `propose` → creates a draft issue with the proposed change as a fenced diff. `auto` → calls `forge_skills.update` and reports the change. |
| **5 — Output run report** | Embeds a structured JSON sentinel in the final message. The platform reads it to update `applied_message_versions` (idempotency). |

### Idempotency

Each schedule row stores `applied_message_versions: { [key]: version }`. On every run,
the agent skips messages whose recorded version ≥ the registry version. When the
registry version increments (content changed), the message re-processes — the agent
reads the new guidance and re-evaluates.

`skipped` outcomes are intentionally **not** recorded in `applied_message_versions`.
If the condition that caused a skip changes (e.g. the project gains a FE surface), the
message will be re-evaluated on the next run.

---

## The `appliesWhen` contract

`appliesWhen` is a **natural-language condition string**, not a TypeScript predicate.
The agent evaluates it against project config + codebase at run time and records its
reasoning.

This is intentional: conditions like "project has a FE/UI surface" or "base-merge state
is a manual gate" require judgment over config + code that a cheap deterministic function
cannot reliably cover. A future iteration may add an optional structured predicate for
trivially-checkable conditions, but v1 uses LLM judgment throughout.

---

## Writing a new message (registry authoring)

Add an entry to `packages/core/src/schedules/messages/registry.ts`:

```ts
{
  key: 'my-practice-key',       // Stable kebab-case; never reuse a retired key
  title: 'Short title',
  message: `
    Detailed guidance for the agent. Write as if briefing a teammate:
    what to do, in what order, and what to check. Be specific about
    the target skill(s) and the exact behavior to add or change.
  `,
  rationale: 'One-sentence explanation of why this matters.',
  appliesToSkills: ['forge-test'],   // Optional; hints the agent at the target skill(s)
  appliesWhen: 'Human-readable condition that must hold for this message to be relevant.',
  category: 'pipeline-correctness', // See ImprovementMessageCategory in registry.ts
  version: 1,                        // Increment on any content change
  recommended: true,                 // Show a "Recommended" badge in the catalog
  defaultMode: 'propose',            // Start conservative; use 'auto' only for well-tested messages
},
```

Versioning rules:
- Increment `version` on **any** content change to `message`, `appliesWhen`, or `rationale`.
- Do **not** reuse a retired key — create a new key with a new name.
- Bump `version` when you want all projects that have already applied the message to
  re-process it with the updated guidance.

Message authoring principles:
- Write the `message` as a concrete, ordered action list — not abstract advice.
- `appliesWhen` should describe a condition verifiable from project config or codebase;
  avoid conditions that require external state (e.g. "project has a live deploy").
- Default `defaultMode` to `propose` until the message has been validated across
  several projects; switch to `auto` only when confident the guidance is universally safe.
- Keep `appliesToSkills` accurate — the agent reads those skills first and tailors its
  change to their existing body.

---

## Divergence example

The same `merged-at-on-pass` message applied to three differently-configured projects:

| Project | baseBranch | mergeStates | Outcome |
|---------|------------|-------------|---------|
| forge-dev | main | released (manual gate) | **proposed** — stamp is needed |
| anhome | main | tested (auto-stamps) | **skipped** — stamp already present |
| dodgeprint | main | (unset) | **skipped** — `appliesWhen` condition not met |

Same message, three different outcomes. No project is force-updated.

---

## Non-goals (v1)

- No global → project override or sync.
- No skill homogenization — the agent tailors, not copies.
- No cross-project observability ("which projects applied message X") — per-project run
  log only.
- No new runner — improvement schedules reuse the existing cron + agent-session rails.
