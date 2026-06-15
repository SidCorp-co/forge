---
title: Getting started
section: Getting started
order: 10
---

# Getting started with Forge

Forge runs your work as an automated pipeline: you file an issue, and agents
move it through triage → plan → code → review → release on a machine you
control. This page is the shortest path from zero to a running pipeline.

## The four pieces

- **Project** — a workspace tied to one code repository. Issues, runs, and
  settings live here.
- **Organization** — who can access your projects. Everyone starts in a
  personal org; create a team org to share with others.
- **Device & runner** — a machine running the `forge-runner` agent that
  actually executes jobs against a checkout of your repo.
- **Pipeline** — the stages an issue passes through. Each stage runs an agent or
  waits for your click, per your settings.

## Steps

1. **Create a project.** From the projects console, choose **New project**, give
   it a name, and pick the organization it belongs to.
2. **Pair a runner.** A project needs a machine to run jobs. Follow
   [Pair a runner](pair-a-runner) — install the agent, approve it, and assign it
   to your project.
3. **File your first issue.** Open the project, create an issue describing what
   you want done, and let triage pick it up. Watch it advance through the
   pipeline on the board.

## Verify it worked

- The project appears in your console under the right organization.
- Your device shows **online** under **Runners**.
- A new issue moves from `open` to `confirmed` shortly after you file it.

## Next

- [Pair a runner](pair-a-runner) — the one piece most setups get stuck on.
- [Manage your organization](manage-your-organization) — invite teammates and
  set roles.
- [Troubleshooting](troubleshooting) — if something doesn't light up.
