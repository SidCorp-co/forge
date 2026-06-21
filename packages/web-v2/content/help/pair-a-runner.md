---
title: Pair a runner
section: Getting started
order: 20
---

# Pair a runner

A **runner** is the `forge-runner` agent running on a machine you control. It
pairs to your account as a **device**, you assign it to a project, and it runs
the project's pipeline jobs by launching Claude locally against a checkout of
your repo. There is no desktop app — pairing is done from the command line.

## Prerequisites

- An account with a **verified email**.
- A project already created — note its **slug**.
- On the machine: the **Claude CLI** installed and signed in. The agent launches
  it to do the work; if it isn't available, jobs stay queued.
- A local **git checkout** of the project's repo on that machine.

## Steps

1. **Install the agent**

   ```bash
   curl -fsSL https://<your-forge-host>/install.sh | sh
   forge-runner --version
   ```

2. **Pair the machine**

   ```bash
   forge-runner login
   ```

   This opens your browser to approve the device. On a headless box, generate a
   code from **Runners → Pair a device** and run `forge-runner login --code <code>`
   instead.

3. **Assign the device to your project** — from the dashboard: **Runners** →
   **Manage** the device → assign it to your project (or **Project → Settings →
   Runners**). This step is required; the next command won't work without it.

4. **Point it at your local checkout**

   ```bash
   forge-runner bind <project-slug> --path /path/to/your/repo
   ```

   The repo must already be cloned on the machine.

5. **Start the agent**

   ```bash
   forge-runner start          # or: forge-runner service install  (run on boot)
   ```

## Verify it worked

- The device shows **online** under **Runners** with a recent "last seen".
- `forge-runner status` reports connected; `forge-runner doctor` passes its
  checks.
- File a test issue in the project — the device picks up the job within seconds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `bind` says the slug isn't assigned | Do step 3 first — assign the device to the project. |
| Device stays **offline** | Is the agent running (`forge-runner status`)? Can it reach your Forge host? |
| Device online but jobs stay queued | Is the project bound (step 4)? Is the Claude CLI installed on that machine? |

See [Troubleshooting](troubleshooting) for more.
