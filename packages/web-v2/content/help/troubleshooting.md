---
title: Troubleshooting
section: Troubleshooting
order: 10
audience: user
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
  [Pair a runner](?path=pair-a-runner).
- Is the runner already busy? A runner takes only as many jobs at once as it is
  set up for, and the rest wait in the queue.
- Is the **Claude CLI** installed and signed in on the runner machine? The agent
  launches it to do the work.

## The pairing code expired

Codes are valid for a few minutes. Generate a fresh one and run
`forge-runner login` again.

## An issue isn't moving

- At **Open**, check **Settings → Pipeline**: **Start queued issues
  automatically** may be off, or the pipeline itself may be switched off.
- At **Draft**, the intake gate may be holding it for approval — move it to
  **Open** to let it in.
- At **Needs info**, **On hold** or **Awaiting release**, it is waiting on a
  person. [Read an issue's status](?path=issue-statuses) says what each one
  needs from you.

## I can't see a project / I get "not a member"

Project access comes from your organization role or an explicit invite. Ask an
owner/admin of the project's org to add you, or check you're in the right
organization with the sidebar switcher.

## Still stuck?

Capture what you see (the issue, the stage, any error) and reach out to your
Forge administrator.
