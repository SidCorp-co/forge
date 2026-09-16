---
name: forge-onboard
description: "Interactive onboarding conversation that surveys a freshly-bootstrapped project's real repo and builds its initial Project Brain — knowledge entries (overview / workflow / rules / guides), a handful of seed memories, and a proposed pipeline config — through a chat that asks one question at a time and never writes without an explicit human confirm. Use right after a project has bound a runner and run pipeline bootstrap, when its knowledge/memory/pipelineConfig are still empty. Triggers on: /forge-onboard, build project brain, onboard this project, survey the repo for Forge."
user_invocable: true
arguments: ""
---

# Forge Onboard — build the Project Brain

A brand-new Forge project has skills wired and a pipeline preset applied, but its "brain" is
empty: nothing has read the actual repo and turned it into knowledge entries /
seed memory / a tuned pipeline config. This skill is that first conversation. It runs once, at
the start of a fresh chat session, and drives a short human-in-the-loop interview to fill that
gap — never by guessing silently and writing, always by proposing and waiting for a yes.

## Hard rules (non-negotiable)

1. **One question per turn.** When you need to ask the human something, ask exactly ONE question,
   then END YOUR TURN immediately — no follow-up questions stacked in the same message, no "while
   I wait, let me also ask...". The reply arrives as the next turn (the session resumes
   automatically); you pick up the conversation from there.
2. **Never write without an explicit confirm.** Before any `forge_knowledge` upsert, `forge_memory`
   write, `forge_knowledge` write, `forge_config` pipelineConfig patch, or pipeline-config change, present a
   short plain-English summary of exactly what you intend to write and ask "Write this?" (a single
   question, per rule 1). Only write after an unambiguous yes. A "no", a follow-up question, or the
   user closing the tab must never leave a partial write behind — nothing you propose exists until
   it is confirmed.
3. **Acknowledge every write.** Immediately after a confirmed write succeeds, say so in one line
   ("Saved: <what>"). If a write fails, say so plainly and offer to retry — never fail silently and
   move on as if it worked.
4. **No dead ends.** At any point the human can decline a proposal, ask something unrelated, or
   just stop — the conversation keeps working (or ends cleanly) either way; it never gets stuck
   waiting on a write that will never be confirmed.

## Flow

### 1. Survey the repo silently (no questions yet)

Before asking anything, spend this first turn reading what the repo already tells you — the goal
is to minimize what you have to ask a human. Useful sources, whatever exists:

- Root docs: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/` — project purpose, architecture,
  conventions already written down.
- Workspace shape: package manager + monorepo config (`package.json`/`pnpm-workspace.yaml`,
  `Cargo.toml`, `go.mod`, …), the list of packages/services and what each does.
- Build/test/lint: scripts in `package.json`, CI workflow files (`.github/workflows/`), Makefiles.
- Branch model: default branch, any release-branch convention (`git branch -a`, `git log
  --oneline -20` on the default branch).
- Domain: what the product actually does — infer from README + top-level route/module names, not
  from file internals.

Do not ask the human to repeat anything you can determine this way.

### 2. Ask about the gaps — one at a time

For whatever the survey could NOT determine (business domain nuance, team conventions not written
down anywhere, which branch is the real production target, anything genuinely ambiguous), ask ONE
short, concrete question per turn (rule 1). Prefer closed or example-anchored questions ("Is `main`
also what you deploy to production, or is there a separate release branch?") over open essay
prompts. Stop asking once you have enough to write a useful first draft — this is a seed, not an
exhaustive audit; a later `forge-product-map` / re-run of this skill can refine it.

### 3. Propose the Project Brain, then wait for confirm

Summarize what you plan to write, grouped by target, then ask "Write this?" (rule 2):

- **Always-injected entries** (`forge_knowledge` action=write, `injection: "always"`) — durable,
  kebab-case slugs holding what every stage should see: a hard rule, a non-obvious convention, the
  build and test commands. Their bodies are rendered verbatim into every prompt for this project, so
  use `always` sparingly; most entries stay `on_demand` and are fetched by slug when a task needs
  them. `{{project:<key>}}` in a skill body no longer reaches these — it answers reserved names
  derived from project columns only, and anything else with a refusal naming this tool (ISS-1048).
- **Knowledge entries** (`forge_knowledge` action=write) — at minimum an `overview` entry (what
  the product is, its major feature areas); add `workflow` (a key entity's lifecycle) or `rule`
  entries only when the survey surfaced something concrete enough to diagram or state as a
  constraint. Don't invent detail you don't have evidence for — a thin, honest overview beats a
  padded one. Set `authoredBy: "agent"`.
- **Seed memory** (`forge_memory` action=write) — a handful of durable, non-obvious facts a future
  agent session would otherwise have to rediscover (a real gotcha, a firm convention, a pointer to
  where truth lives). Follow the `forge-memory-curator` contract: the 3-question gate (worth it? /
  right place — not already in code or CLAUDE.md? / safe & findable as one secret-free fact under a
  stable slug?), taxonomy (`policy` for working rules, `knowledge` for durable facts/pointers,
  `decision` for a dated architectural choice), dense `textContent` (~150–800 chars, lead line
  ≤160 chars, one fact per line, no prose padding), stable kebab `sourceRef` slug, and — the
  non-negotiable one — **never put a secret in `textContent`; store a pointer to where it lives
  instead.** Search (`forge_memory` action=search) before writing so you upsert an existing slug
  instead of duplicating a topic.
- **Pipeline config** (`forge_config` action=update, `pipelineConfig`/`baseBranch`/
  `productionBranch`) — propose ONLY when the survey found real evidence contradicting the current
  default (e.g. the actual release branch differs from what bootstrap assumed). Do not propose
  a change with nothing behind it.

If the human confirms, write each group and acknowledge it (rule 3). If they decline a group,
skip it and move on — do not re-propose it later in the same conversation unless asked.

### 4. Close out

Once the confirmed groups are written (or all declined), say what was saved (or that nothing was),
and mention that this can be re-run any time to add more — this is a starting point, not a final
state.

## Common mistakes to avoid

- Asking more than one question in a single turn — breaks the resume model this skill depends on.
- Writing anything (`forge_knowledge`, `forge_memory`, `forge_config`) before an explicit "yes" to
  that specific proposal.
- Putting a credential, token, or connection string into a knowledge entry or memory `textContent`
  — store a pointer to where it lives instead.
- Padding the overview/rule entries with guesses to look thorough — an honest, thin first draft
  that the human can correct beats a confident wrong one.
- Silently swallowing a failed write — always say when something didn't save.
