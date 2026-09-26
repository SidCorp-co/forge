# Forge Runner

Lightweight pure-Rust CLI daemon that brokers between Forge **core** and the local
machine: pairs as a device, receives jobs over WebSocket, runs them with the Claude
Code CLI (future: codex), and streams events back.

Replaces the Tauri desktop app.

## Layout

- `crates/forge-runner-core` — the lib: transport, auth, runner abstraction, workspace,
  mcp, daemon orchestration. No CLI/GUI knowledge → a thin GUI/tray can reuse it later.
- `crates/forge-runner` — the `clap` binary that drives the lib.

## Status (M1–M4 implemented, Linux-first)

Working: pairing (`login --code`), credential store (keychain + `0600` file
fallback), WebSocket connect/subscribe/reconnect, 30s heartbeat, job dispatch
→ Claude CLI run (worktree + MCP config) → streamed events + complete/fail,
cancel/abort, `doctor`, `bind`, `status`, `runners`, `service install`
(systemd). Release binary ≈ 3.7 MB.

Deferred: Windows/WSL spawn; `status --watch` TUI; auto-clone; reporting
`claudeSessionId` to `agent_sessions` for resume.

(Browser-approve login and `install.sh`/binary release have both SHIPPED —
`login` is the OAuth device flow, and this same README pipes `install.sh` 60
lines below. They were listed here as deferred long after they landed.)

## Subcommands

`forge-runner --help` is authoritative; the set today is:

| Command | What |
|---|---|
| `api` | Call any Forge REST endpoint with a personal access token (`gh api` shaped) |
| `setup` | Installed → running work: check tools, pair, pick projects, get checkouts, install the service, end on `doctor` |
| `login` | Pair this device: prints an approval URL (`--open` launches a browser); `--pat` stores a REST token instead |
| `bind` | Bind a project slug to a local repo path |
| `start` | Run the daemon — connect, register, accept jobs |
| `status` | Connection + runner status |
| `logs` | Tail the runner log |
| `config` | Inspect or edit local config |
| `doctor` | Diagnose the environment (claude CLI, git, cred store, core reachability) |
| `service` | Install/uninstall the OS service (systemd/launchd) |
| `runners` | List runners registered for this device |
| `sync` | Pull the latest skills for bound projects now (one-shot) |
| `update` | Self-update from the release manifest |

### `api` — the REST surface from a shell

```
forge-runner api issues                        # GET  /api/issues
forge-runner api /api/issues -X POST -d '{…}'  # or `-d -` to read stdin
forge-runner api projects -H 'X-Trace: abc' -i # extra header, show response headers
```

`issues`, `/issues` and `/api/issues` all mean the same endpoint. The project
slug comes from `--project`, else `$FORGE_PROJECT_SLUG`, else the sole bound
project — with two or more bindings it resolves to **nothing** rather than
guessing, so an ambiguous call is refused instead of hitting the wrong project.

A failure is reported twice: as an exit code (`--help` prints the table) and as
JSON on stderr carrying `retryable`, which is true only where the identical
request could later succeed — a 429, a 5xx, or a dropped connection on an
idempotent method. A conflict or a rejected body is never retryable, and
neither is a dropped connection on a `POST`/`PATCH`: that exits `10`
`DELIVERY_UNKNOWN`, because the write may already have landed and the only
safe next move is to read the state back. The response body of a failed
call goes to stderr and never stdout, so `… > out.json` leaves that file empty
on failure rather than filling it with an error shaped like an answer.

**Credential.** `api` speaks with a **personal access token**, not the device
token — a device token names a machine, and REST fences a caller by the
projects its credential may speak for. Mint one in the web UI under
Settings → API Tokens, then either:

```
forge-runner login --pat forge_pat_…   # stored beside the device token
export FORGE_PAT=forge_pat_…           # or per-shell, which wins over the store
```

The same token is what every job the box starts hands its Forge tools, so a
box holding none refuses its jobs, and `forge-runner doctor` fails on it.

**Reach.** A token bound to a project reaches that project and 404s on every
other — the same answer a project that does not exist gives, so a token cannot
be used to discover which project ids are real. Routes that resolve no project
(`/api/pat`, `/api/orgs`, `/api/admin`, `/api/me`) refuse a PAT outright with
`PAT_NOT_PERMITTED`: there is nothing there for the fence to bite on, and a
token that could mint another token would have no scope at all. A token minted
without the `write` scope gets `INSUFFICIENT_SCOPE` on anything but a read.

### Skill delivery

Skills reach a runner without a manual step: `[skills] auto_pull` is **on by
default**, so a bound project's skills are pulled in the background as they are
published or updated. `forge-runner sync` forces that now. Device-wide shared
skills arrive over a second channel, the Claude Code plugin marketplace: every
device installs the first-party `forge` plugin from `SidCorp-co/forge-plugin` —
the `forge` CLI, the session hooks and the `issue-flow` driver skill a `drive`
job runs. It is on by default; `forge-runner config set plugins.enabled false`
opts a machine out, and `plugins.marketplace-repo` / `plugins.plugin-names`
point it elsewhere. A config still naming the retired `forge-pipeline-skills`
marketplace is moved onto the first-party one at load, with a warning naming
the file. What a runner actually ended up executing is reported back — see `observed_sha` /
`shadowed_by` on the device-skill row, which is what makes a green sync status
mean the pushed body is the body that runs.

```bash
cargo build --release
./target/release/forge-runner config set core-url <url>   # the installer does this for you
./target/release/forge-runner setup                       # pair + bind + service + doctor
```

`setup` is the order the steps below go in, not a second implementation of
them: pairing is `login`'s, the checkout is the server's provisioning path
(`workspace/provision.rs`, the same one a web-UI assignment triggers), the
service is `service install`'s and the verdict is `doctor`'s. Every question it
asks has a flag, and with `--yes` or no tty it asks none — `--code`,
`--project`, `--path`, `--projects-root`, `--service` / `--no-service`. It ends
non-zero when doctor fails, so an unattended install fails where the gap is.

The steps by hand, when you want them one at a time:

```bash
./target/release/forge-runner login                       # prints the approval URL; --open for a browser
./target/release/forge-runner bind <slug> --path <dir>    # or --clone to have one provisioned
./target/release/forge-runner start
```

## Multiple instances on one machine (ISS-467)

To run several runners on one box — e.g. one per Claude account for
quota-failover — each must be a **distinct device**. Core dedups devices by
`(owner, sha256(machine_id))` and **rotates the token in place**, so without a
unique machine-id every `forge-runner login` from the same box collapses onto
one device row and overwrites the others' tokens (which knocks the running
daemons offline with `[ws] auth failed (401)`).

Give each instance its own identity and config before its first `login`:

```bash
# Per instance (e.g. account ai006):
export FORGE_RUNNER_MACHINE_ID=$(hostname)-ai006   # unique → distinct device row
export XDG_CONFIG_HOME=$HOME/.config/forge-runner-ai006  # separate config.toml + credentials.json
export FORGE_RUNNER_CRED_STORE=file                # deterministic token store across shell/systemd
export CLAUDE_CONFIG_DIR=$HOME/.claude-ai006       # the account this instance runs as
forge-runner login --core-url <url> --code <CODE>
forge-runner bind <slug> --path <dir>
forge-runner start
```

`FORGE_RUNNER_MACHINE_ID` must be set **before the first login** — it decides
which device row the runner claims. For a systemd unit, put these in the unit's
`Environment=` lines (one unit per instance) and disable `update.auto` if the
instances share a single binary. A dead/rotated token no longer crash-loops the
daemon: on `401` it logs loudly and backs off instead of exiting into a
fixed-interval restart loop. When you re-`login`, the daemon detects the new
token (within ~30s) and performs a single controlled restart to apply it across
every client (WebSocket + HTTP) — no manual `systemctl restart` needed.

## Auto-update (ISS-392)

The daemon checks `{core}/api/install/latest.json` ~30s after start and every 6h.
When a newer release is published it downloads the matching binary, verifies its
sha256, swaps the executable, and restarts the systemd service.

Auto-update is **ON by default**. The restart **drains to idle first**, so an
update never kills running work:

- **Admission closes for the drain.** From the moment it begins the daemon
  declares no new run, takes no pool job, and places or nudges no master, for
  every project it serves — a drain that went on admitting work waited on a
  queue it kept refilling (ISS-1223). Chat turns and messages into a master pane
  are still taken, and counted as holders, because they have no way to tell the
  person waiting that they were refused.
- **It speaks while it waits**: a line at the start and every 10 minutes naming
  each run, by id and issue key, and each interactive turn still holding it.
- **It is bounded at 2h.** Past that it does not restart: it names what still holds
  it, reopens admission, and no drain may close it again for another 2h. The
  next attempt is the next update check.
- **What that costs when the work never ends.** Each attempt closes admission
  for the full 2h again. A box holding a run that outlives it stays closed to
  new runs, pool jobs and masters for 2h of every 6h under a pending update, or
  2h of every 4h under a pending re-login. Before this, a drain closed nothing
  and cost no admission time, but it also never turned the box over. The give-up
  line states the cycle. The cost ends when that work ends, or when an operator
  restarts the service by hand.

Until the restart, the daemon serves the build it started on while the newer
file stands on disk. `forge-runner status` prints both — `binary` for the file,
`daemon` for what the running daemon recorded it serves, with its drain — and
`forge-runner --version` adds a line on stderr when the two differ, leaving its
stdout unchanged.

**Both lines speak about one configuration: the one this command resolves.** A
box runs more than one daemon whenever somebody starts a second under its own
`XDG_CONFIG_HOME`, and the `forge-runner-<id>` units are built for it. Where the
record names no live daemon — there is none, it is gone, its pid is now another
process, or the file will not parse — `status` says which of those holds, and
then looks at the `forge-runner start` processes running here. It names one only
where that process's own environment resolves to this configuration; one that
resolves to another is counted and its directory named, as what it is; one whose
environment cannot be read is named as unattributed rather than claimed either
way. It never reads a build off a process that wrote no record, because nothing
can (ISS-1223).

`forge-runner update --restart` asks the daemon, not the file. The file on disk
being the latest is exactly the state a deferred drain leaves — updated, not yet
turned over — so `--restart` there restarts the daemon when it is serving an
older build, says there is nothing to restart when it already serves this one,
and says which case holds when it cannot tell. It asks the same question after
an update it has just applied, where a daemon agreeing with the build of the
command is agreeing with the file that was replaced under it, and so lags by
construction. Where no daemon can be named at all there, it restarts the box's
one unit because the file that unit runs was replaced — saying, in those words,
that this is not a claim about whose daemon it is, and that a daemon started
some other way still runs the old build. Two things it will not do, on either
branch:

- **It never cuts into a drain that is under way.** A draining daemon is
  restarting itself and waiting for the work it holds, so a restart there would
  stop exactly that work. It names the cause and every holder instead, and
  leaves the box to turn itself over. A drain that gave up is the opposite case
  and is restarted.
- **It restarts only the unit whose main process is that daemon.** The pid comes
  from one configuration's record, and on a box running a second daemon the
  single `forge-runner*.service` unit need not be it — restarting that one would
  leave the daemon that lagged lagging and stop another mid-job. Where no unit
  answers for the pid, it refuses by name and lists what each unit is running.
  Where this platform cannot confirm the pid is still that daemon, it restarts
  nothing at all: `status` declines to assert that identity, and a restart is
  that assertion with a `systemctl` behind it.

Control it without editing TOML:

```bash
forge-runner config set update.auto false   # opt this device out
forge-runner config set update.auto true    # opt back in
forge-runner config set update.manifest-url https://<core>/api/install/latest.json
```

The installer enables it by default; pass `--no-auto-update` to opt out at install
time: `curl -fsSL https://<core>/api/install.sh | sh -s -- --no-auto-update`.

## Where a release comes from (ISS-1165)

**Nobody cuts the tag.** A change under `packages/runner/` that lands on `main`
triggers `.github/workflows/runner-autorelease.yml`, which computes the next
version, creates `runner-v<next>` at the commit that landed, and calls
`runner-release.yml` in the same run — called and not triggered, because a tag
pushed with the workflow's own `GITHUB_TOKEN` starts no workflow run. What comes
out is a GitHub Release carrying the two `forge-runner-<target>` binaries,
`VERSION` and `COMMIT`. Core picks that up within 30 minutes and boxes with
`update.auto` apply it on their next check.

**`[workspace.package] version` in `Cargo.toml` is the LINE, not the released
version.** It declares the major.minor; the patch is the release counter that
`scripts/next-runner-version.mjs` reads off the existing tags, and the release
build stamps the result in through `FORGE_RUNNER_VERSION`. Raise the major or the
minor in `Cargo.toml` when a release deserves one; never the patch. The reason is
that `main` carries a required status check, so no CI push of a version-bump
commit can reach it — a tag push can.

**What a binary answers with is what core compares it against.**
`forge-runner --version` prints the released version and the commit it was built
from; a `cargo build` that nothing stamped prints Cargo's own version and
`unknown`, which is the truth about it — it is not a published build, and core
reports such a box as unknown rather than current rather than guessing.

The stamped commit is the newest commit that **touched `packages/runner`**, not the
head of the push that carried it: one push can hold a runner commit followed by an
unrelated one, and core reads the branch the same way, so stamping the push head
would leave a freshly updated box reading as behind for ever. A commit some release
already carries is refused rather than released again — a rerun of an older release
job would otherwise publish that code under a version higher than what followed it.

Withdrawing a release takes two acts, not one: core's
`packages/core/src/install/fetch-release.ts` never moves `RUNNER_RELEASE_DIR` backwards,
so deleting a tag and its GitHub Release leaves
the bad build still being served. Either delete `VERSION` and the
`forge-runner-*` assets from that directory on the core host, or publish a higher
corrective release — then read `/api/install/latest.json` back before reinstalling
anything.
