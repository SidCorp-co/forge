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
- Your **Forge host** — the address the runner connects to. This can differ
  from the web address you log in to; if you're not sure, ask your Forge admin.
  Everywhere below, use it in place of `<your-forge-host>`.

## Steps

1. **Install the agent**

   ```bash
   curl -fsSL https://<your-forge-host>/install.sh | sh
   forge-runner --version
   ```

   The agent installs to `~/.local/bin`. If that isn't on your `PATH`, the
   installer prints the line to add — run it, or open a new shell.

2. **Pair the machine**

   Run this in an interactive terminal:

   ```bash
   forge-runner login --core-url https://<your-forge-host>
   ```

   Pass `--core-url` on this first run — the machine doesn't know your host yet
   (it's remembered afterwards). The command prints a pairing code and a link
   and opens your browser to **approve this device**. Approve **promptly** — the
   code expires after a couple of minutes.

   **No browser on the machine (a server)?** Add `--no-browser` to print the
   link instead, then open it on any device where you're signed in:

   ```bash
   forge-runner login --core-url https://<your-forge-host> --no-browser
   ```

   Or paste a code you generated under **Runners → Pair a device**:

   ```bash
   forge-runner login --core-url https://<your-forge-host> --code <code>
   ```

3. **Assign the device to your project** — from the dashboard: **Runners** →
   **Manage** the device → assign it to your project (or **Project → Settings →
   Runners**). This step is required; the next command won't work without it.

4. **Point it at your local checkout**

   ```bash
   forge-runner bind <project-slug> --path /path/to/your/repo
   ```

   The repo must already be cloned on the machine.

5. **Start the agent**

   On a server, install it as a background service — it starts on boot and keeps
   running after you log out:

   ```bash
   forge-runner service install
   ```

   For a quick foreground test instead:

   ```bash
   forge-runner start
   ```

## Verify it worked

- Run `forge-runner doctor` — it checks the Claude CLI, git, your pairing, the
  binding, and that it can reach your Forge host. You want **VERDICT PASS**.
- The device shows **online** under **Runners** with a recent "last seen".
- File a test issue in the project — the device picks up the job within seconds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `login` says `no core URL` | Pass `--core-url https://<your-forge-host>` — it's required the first time. |
| Pairing fails with a server / gateway error (e.g. 502) | It's transient. Just run the `forge-runner login …` command again. |
| Pairing code expired | Codes last only a couple of minutes. Run `login` again and approve right away. |
| `bind` says the slug isn't assigned | Do step 3 first — assign the device to the project. |
| Device stays **offline** | Is the agent running (`forge-runner status`)? Can it reach your Forge host? |
| Device online but jobs stay queued | Is the project bound (step 4)? Is the Claude CLI installed **and signed in** on that machine? |

See [Troubleshooting](troubleshooting) for more.
