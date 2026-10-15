---
title: Configure the pipeline & approvals
section: Guides
order: 20
audience: user
---

# Configure the pipeline & approvals

Your project's **pipeline** takes each issue from filed to shipped. One agent
picks an issue up and carries it the whole way — it works out what is asked,
builds it, checks it and hands it on for release. There is no list of stages to
set one by one: you decide **whether work starts on its own**, **whether new
issues need your approval first**, and **whether anything waits to be
released**.

## Prerequisites

- Admin access to the project. Every setting below is under the project's
  **Settings**.

## Turn the pipeline on or off

In **Settings → Pipeline**, **Pipeline enabled** is the master switch. While it
is off, no agent is sent any work for this project.

## Hold issues until someone starts them

**Start queued issues automatically**, on the same tab, decides whether an
**Open** issue is picked up by itself. Turn it off and every issue stays at
**Open** until someone starts it. Nothing else about the pipeline changes.

## Approve new issues before work starts

Under **Intake gate** on the same tab, turn on **Require human approval for new
issues**. Every new issue — whoever or whatever filed it — then waits at
**Draft** with the **intake** label. Approve one by moving it to **Open**;
turn it down by moving it to **Dropped**. **Notify the project owner on each
gated issue** tells the owner each time one arrives.

## Approve a release

Built and checked work waits at **Awaiting release** only while the project
declares a release **and** a live deploy target serves it. Both are on
**Settings → Shape & release**; a project that ships nothing closes each issue
once its work is done.

At **Awaiting release**, the issue page says when it goes out — the next
scheduled release, or none until a person cuts one. People who can release see
a **Release now** button there.

## Pause and resume an issue

Put an issue **On hold** from its menu and the pipeline leaves it alone until
**you resume it**. A paused issue never moves on its own.

## Verify it worked

- **Settings → Pipeline** shows each switch where you set it.
- With **Start queued issues automatically** off, a new issue stays at **Open**.
- With the intake gate on, a new issue arrives at **Draft** with the **intake**
  label.
- A finished issue in a project that declares a release reads **Awaiting
  release**, and its page says when it goes out.

## Troubleshooting

| Symptom | What is going on |
|---------|------------------|
| Nothing is picked up at all | Check **Pipeline enabled**, and that a runner is online for the project. |
| Issues sit at **Open** | **Start queued issues automatically** is off — start them by hand, or turn it on. |
| New issues land at **Draft** | The intake gate is on. Move each one to **Open** to approve it. |
| An issue sits at **Awaiting release** | It waits for a release. Its page says when the next one runs, and **Release now** cuts one. |
| A paused issue isn't moving | On-hold issues only restart when **you resume** them. |

See also [Read an issue's status](?path=issue-statuses) and
[Troubleshooting](?path=troubleshooting).
