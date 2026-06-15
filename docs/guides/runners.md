# Set up a runner (device) for a project

A **runner** is the `forge-runner` daemon running on a machine you control. It
pairs to your account as a **device**, binds to one or more **projects**, and
executes pipeline jobs by spawning the `claude` CLI locally against a checkout
of the project's repo.

This guide is the headless `forge-runner` path — the only supported runner.
There is no desktop app step.

## Prerequisites

- A Forge server you can reach (the web origin, e.g. `https://your-forge`, and
  its API origin).
- An account on that server with a **verified email**.
- A project already created. Note its **slug** — you bind the runner to it.
- On the runner host: the **`claude` CLI** installed and on `PATH`, signed in to
  a working Claude subscription. The daemon spawns `claude` as a subprocess; if
  it isn't on `PATH`, jobs stay `queued`.
- A local **git checkout** of the project's repo on the runner host (the runner
  binds to an existing directory — see step 4).

## 1. Install `forge-runner`

```bash
curl -fsSL https://your-forge/install.sh | sh
forge-runner --version
```

This drops the `forge-runner` binary on `PATH`. Self-update later with
`forge-runner update` (skip it on hosts that share one patched binary).

## 2. Pair the machine as a device

```bash
forge-runner login
```

This prints an approval URL and opens your browser. **The approval page is on
the web origin, not the API origin** — if the printed link points at the API
host and 404s, open the same `/pair?code=…` path on your web origin instead.
Approve there; the daemon's poll loop receives a device-scoped token.

Headless box with no browser? Mint a code in the dashboard
(**Runners → Pair a device → Generate code**) and pass it:

```bash
forge-runner login --code AB-CD12-34EF
```

Where the token is stored:

- **Interactive / desktop session** — the OS keychain (macOS Keychain, Windows
  Credential Manager, Linux Secret Service).
- **systemd / headless** — set `FORGE_RUNNER_CRED_STORE=file` so the token is
  read from `~/.config/forge-runner/credentials.json` (0600). Under systemd the
  daemon otherwise tries the keychain and ignores the file token.

After approval the device shows **online** in **Runners** within seconds. It is
not yet bound to any project.

## 3. Assign the device to the project

This is a one-time step done **from the dashboard** (or the REST API) — the CLI
cannot assign itself, because the device token can't call the project routes.
`forge-runner bind` will refuse a slug until this assignment exists.

- **Dashboard:** **Runners** → **Manage** the device → **assign it to your
  project** (equivalently, **Project → Settings → Runners**).
- **REST (for automation):**

  ```bash
  POST /api/projects/<projectId>/runners
  { "deviceId": "<deviceId>", "repoPath": "/abs/path/on/runner" }
  ```

  Requires an org owner/admin session (JWT). Idempotent on
  `(project, device, claude-code)`.

## 4. Bind a local checkout

On the runner host, point the assigned project at an **existing** checkout:

```bash
forge-runner bind <project-slug> --path /abs/path/to/repo
```

`bind` writes the per-device repo path/branch back to the server. The repo must
already be cloned — `bind` does not clone for you. (Automatic clone-on-assign
only happens when the project has a `repoUrl` plus a provisioned git
credential.)

## 5. Start the daemon

```bash
forge-runner start            # foreground

# or install as a user service (Linux, recommended for always-on):
forge-runner service install  # systemd --user unit
loginctl enable-linger "$USER"  # so it survives logout / boots without login
```

For a systemd user unit, make sure the unit's environment carries a usable
`PATH` (so `claude` and `node` resolve) and `FORGE_RUNNER_CRED_STORE=file`.

## 6. (Optional) Pin this device as the project's primary

By default the dispatcher prefers a project's primary device, then falls back to
other online devices by most-recently-seen. Pin one explicitly:

```bash
PATCH /api/projects/<projectId>  { "defaultDeviceId": "<deviceId>" }
```

(Dashboard: the device's **Set as default** action under **Runners**.)

## Verify it worked

- **Runners** shows the device **online** with a recent "last seen".
- `forge-runner status` reports connected; `forge-runner doctor` passes its
  checks (token present, WebSocket reachable, repo path exists, `claude` found).
- Create an issue (or send a test webhook) and watch a job dispatch:

  ```bash
  curl -X POST https://your-forge/api/webhooks/in/<project-slug> \
    -H "Content-Type: application/json" \
    -d '{"title":"Runner smoke test","description":"Confirm the runner picks up a job"}'
  ```

  Within seconds the device claims the job, spawns `claude` locally, and streams
  output to the dashboard.

## Concurrency

Each project runs **one issue at a time** (serial, cap = 1). Multiple devices on
one project are for failover / primary-pin, not parallelism. To run work in
parallel, use **separate projects** — one device can serve several projects.

## Multiple runners on one host (advanced)

The server identifies a device by `(owner, machine-id)`, so a second
`forge-runner login` on the same box collapses onto the same device row and
rotates its token — knocking the first daemon offline. To run **N independent
runners on one machine**, give each its own identity and config:

- `FORGE_RUNNER_MACHINE_ID=<unique-per-instance>` — distinct device rows.
- `XDG_CONFIG_HOME=~/.config/forge-runner-<name>` — separate `config.toml` +
  `credentials.json`.
- `FORGE_RUNNER_CRED_STORE=file` and `update.auto=false` if instances share one
  binary (an auto-update would clobber it).

Run each as its own `forge-runner-<name>` systemd user unit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `login` link 404s | The printed link is on the **API** origin; open the same `/pair?code=…` on the **web** origin. |
| Token "lost" under systemd | Set `FORGE_RUNNER_CRED_STORE=file`; the daemon otherwise resolves the keychain and ignores the file token. |
| `bind` → "slug not assigned to this device" | Do step 3 first — assign the device to the project from the dashboard/REST. |
| Device `offline` | Daemon running? (`forge-runner status`). Server URL reachable from the host (not `localhost` if remote)? Check the daemon log for WebSocket connect errors. |
| Device online but jobs stay `queued` | Is the project bound (step 4)? Another job already `running` (cap = 1)? Is `claude` installed and on the daemon's `PATH`? |
| systemd unit: `claude`/`node` not found | The base unit has no `PATH`; add `Environment=PATH=…` (a drop-in override) so subprocesses resolve. |
| `login` "pairing code expired" | Codes are valid ~5 minutes — generate a fresh one. |

## Reference

- [architecture/runner-daemon.md](../architecture/runner-daemon.md) — daemon
  internals, pairing protocol, dispatch routing.
- [modules/devices/README.md](../modules/devices/README.md) — device pairing +
  project-binding mechanics and the device API surface.
- [../quickstart.md](../quickstart.md) — full server + first-job walkthrough.
