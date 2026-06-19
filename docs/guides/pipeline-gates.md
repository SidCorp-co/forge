# Configure Pipeline Stages & the Release Gate

How to control which pipeline stages run automatically, which **pause for a human**, and which are skipped — for **anyone running a Forge project**. This is the day-to-day "how do I make the pipeline stop for approval / run hands-off" guide.

> Reference (the full status list + transition rules): [status-pipeline.md](../modules/issues-pipeline/status-pipeline.md). This guide is the practical layer on top.

**Prerequisites:** a Forge project with the pipeline enabled, and project-admin access (you'll use **Settings → Pipeline**).

## The model — one control per stage

Every pipeline stage is governed by **one setting** with three choices. Forge does **not** have special "gate statuses" — any stage can be a gate. The setting collapses the engine's dispatch rule into a single picker:

| Mode | What it means | What the pipeline does |
|------|---------------|------------------------|
| **Auto** | Run this stage's skill automatically | Dispatches the moment an issue reaches the stage |
| **Manual** | **Gate** — wait for a human | The issue **parks** here. It is **never auto-skipped**. Only a person (or an explicit manual run) advances it |
| **Skip** | Bypass this stage | The pipeline jumps forward to the next enabled stage |

Under the hood a stage auto-runs **only when** the pipeline is enabled **and** the stage is enabled **and** its mode is not `manual` **and** its `auto*` toggle is on. The Auto/Manual/Skip picker sets all of that for you — so **configure here, don't hand-edit `pipelineConfig` JSON** (editing raw JSON is how stale, invisible gates creep in).

## The lifecycle and the single release gate

The happy path runs automatically until the one gate that matters:

```
open ─triage→ confirmed ─clarify→ clarified ─plan→ approved
                                         (waiting — plan-approval gate, if Complex)
approved ─code→ developed ─review→ testing ─test→  ┌──────────────────────┐
                                                   │  tested  ⏸  GATE      │  "Awaiting release"
                                                   └──────────────────────┘
tested ─(a human approves)→ released ─release→ closed
branches: reopen↔fix · needs_info · on_hold · draft
```

- **`tested` = "Awaiting release"** is the single production-approval gate, **Manual by default**. The test stage runs QA against the live deploy and, on PASS, parks the issue at `tested`.
- A **human** reviews and advances `tested → released`, which merges to production and closes the issue.
- That's the only ship-path gate out of the box (`waiting`, the plan-approval gate, is the other optional human checkpoint, earlier).

## Recommended presets

Pick the one that matches how much you want the pipeline to do unattended:

| Preset | Set it up as | Use when |
|--------|--------------|----------|
| **Ship-with-approval** *(default — recommended)* | Everything **Auto**; `tested` = **Manual** | Most projects. The pipeline runs all the way to a verified build, then one person approves the release. |
| **Full auto-ship** | Everything **Auto** (incl. `tested`) | You fully trust the live end-to-end verification and want hands-off shipping. |
| **Two-gate (cautious)** | `waiting` = **Manual** *and* `tested` = **Manual** | Higher-risk work — a human approves the **plan** before coding *and* the **release** before production. |
| **Review-heavy** | `approved` or `developed` = **Manual** | You want a person to eyeball the code before or after the agent writes it. |
| **Lean (skip a stage)** | The stage = **Skip** (or set `skipComplexities: ["xs","s"]` on a stage) | Small issues that don't need, e.g., the clarify step. |

## How to apply it

1. Open **Settings → Pipeline** for the project.
2. For each stage, choose **Auto / Manual / Skip** and (for Auto stages) pick the skill that runs there.
3. Save. The change takes effect on the next issue that reaches each stage.

**`mergeStates`** (same settings page) tells the engine which status stamps `merged_at` — used to unblock issues that depend on this one (`blocked_by`). Trunk-based projects leave it at `released`; set `baseBranch = tested` if you want dependents to unblock as soon as QA passes (at the gate) rather than at final close.

## Golden rules

1. **One gate by default — `tested`.** Don't rebuild a multi-gate flow.
2. **`Manual` is the gate primitive.** It works on *any* stage and is never auto-skipped — that's the whole mechanism.
3. **Two-branch projects (staging → production) do not need a separate staging status.** The code stage deploys to staging, `tested` is the human approval, and the release stage promotes to the production branch.
4. **Configure in Settings → Pipeline, never by editing `pipelineConfig` JSON by hand** — raw edits can leave gates the UI can't show, so the saved config silently drifts from what you see.

> Historical note: earlier Forge versions had separate `pass` / `staging` statuses as extra gates. They were removed — `tested` is now the single pre-production gate. Any old config or doc mentioning `pass`/`staging` as a live status is stale.
