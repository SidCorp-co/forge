---
title: Troubleshooting
section: Troubleshooting
order: 10
---

# Troubleshooting

Common issues and how to clear them.

## Device shows offline

- Confirm the agent is running on the machine: `forge-runner status`.
- Make sure the machine can reach your Forge host (not `localhost` if Forge runs
  elsewhere).
- Check the agent log for connection errors.

## A job is stuck in "queued"

- Is a device **assigned to the project and bound** to a local checkout? See
  [Pair a runner](pair-a-runner).
- Is another job already running? Each project runs **one issue at a time**.
- Is the **Claude CLI** installed and signed in on the runner machine? The agent
  launches it to do the work.

## The pairing code expired

Codes are valid for a few minutes. Generate a fresh one and run
`forge-runner login` again.

## An issue won't advance past a stage

- Some stages **wait for your click** rather than running automatically — open
  the issue and look for the action button.
- A stage can be turned off for the project in **Project → Settings → Pipeline**.
- If a stage has no agent configured for it, it's skipped.

## I can't see a project / I get "not a member"

Project access comes from your organization role or an explicit invite. Ask an
owner/admin of the project's org to add you, or check you're in the right
organization with the sidebar switcher.

## Still stuck?

Capture what you see (the issue, the stage, any error) and reach out to your
Forge administrator.
