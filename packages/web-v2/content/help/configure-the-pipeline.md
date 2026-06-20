---
title: Configure the pipeline & approvals
section: Guides
order: 20
---

# Configure the pipeline & approvals

Your project's **pipeline** moves each issue through a series of stages —
triage, clarify, plan, code, review, test, release. This page shows how to
choose which stages run on their own, which **pause and wait for your
approval**, and which are skipped.

You do all of this in **Settings → Pipeline**.

## Prerequisites

- A project with the pipeline enabled.
- Admin access to the project (you'll use **Settings → Pipeline**).

## How each stage runs — one setting, three choices

Every stage has a single setting with three options:

| Setting | What happens |
|---------|--------------|
| **Auto** | The stage runs by itself as soon as an issue reaches it. |
| **Manual** | The stage **waits for you**. The issue parks here until you approve it. It is never skipped automatically. |
| **Skip** | The stage is bypassed — the issue jumps to the next stage. |

That's the whole model: any stage can become an approval gate just by setting
it to **Manual**.

## The default flow and the release gate

Out of the box, everything runs automatically until the one approval that
matters — **Awaiting release**:

```
Triage → Clarify → Plan → Code → Review → Test → [ Awaiting release ] → Released → Done
                                                         ⏸
                                                  waits for a person
                                                   to approve the
                                                     release
```

- After the **Test** stage verifies the work, the issue stops at **Awaiting
  release** and waits.
- **You** review it and approve — the issue then releases and closes.

This is the recommended setup: the pipeline does all the work, and a person
makes the final call to ship.

## Make a stage wait for approval

1. Open **Settings → Pipeline** for your project.
2. Find the stage you want to gate.
3. Set it to **Manual**.
4. Save.

From now on, every issue that reaches that stage **parks there** until you
approve it. Open the issue and use its action button to advance it.

Common gates:

- **Approve the release** (default) — keep the **Test** stage's result gated so
  nothing ships without you. This is on by default.
- **Approve the plan before any code** — set the **Code** stage to **Manual**.
  Each issue then waits right after planning, so you can review the plan first.
- **Eyeball the code before it's verified** — set the **Review** stage to
  **Manual**.

## Skip a stage

Set any stage to **Skip** to bypass it. For example, skip **Clarify** for a
project where issues are already well-described. The issue jumps straight to the
next stage.

## Pause and resume an issue

Need to stop an issue mid-flight? Put it **on hold** from the issue's menu. It
stays paused — the pipeline won't touch it — until **you resume it**. Resuming
is the only thing that restarts the work, so a paused issue never moves on its
own.

## Recommended setups

| Setup | How to set it | Use when |
|-------|---------------|----------|
| **Ship with approval** *(default)* | Everything **Auto**; release stays gated | Most projects — hands-off until the final release approval. |
| **Fully automatic** | Everything **Auto**, including release | You trust the automated checks and want hands-off shipping. |
| **Cautious** | **Code** = Manual *and* release gated | Higher-risk work — approve the plan before coding *and* the release before shipping. |
| **Review-heavy** | **Review** = Manual | You want to read the code before it's verified. |

## Verify it worked

- Open **Settings → Pipeline** and confirm each stage shows the mode you chose.
- File a test issue. A stage set to **Manual** should **stop and wait** when the
  issue reaches it; a stage set to **Skip** should be passed over.
- A gated issue shows an action button you click to approve and continue.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| An issue won't advance past a stage | That stage is probably set to **Manual** — open the issue and click its approve/advance button. |
| A stage you expected to run was skipped | Check it isn't set to **Skip**, and that a skill is assigned to it in **Settings → Pipeline**. |
| A paused issue isn't moving | On-hold issues only restart when **you resume** them. Resume it from the issue menu. |
| Nothing runs automatically at all | Make sure the pipeline is enabled for the project in **Settings → Pipeline**. |

See also [Troubleshooting](troubleshooting).
