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

Deferred: Windows/WSL spawn; auto-clone; reporting `claudeSessionId` to
`agent_sessions` for resume.

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
| `status` | Connection + runner status; `--watch` is `top` |
| `top` | A live, read-only view of the box: every project, its master pane, the skill that pane stands on and the CLI slug its checkout resolves; every run holding a lease, aged by the newest file under its worktree; what waits on a person; gate and pool health; and each project's tokens and estimated cost over 24h and 7d (see below). Each row names what it read, and a source it cannot read says so. On a unix terminal it opens on a table, one row per project and one for the box: ↑ ↓ or `j` `k` select, Enter opens a row's detail and Esc returns, `s` shows each row's sources, `l` switches the legend, `q` quits. A detail taller than the screen is shown a page per redraw: space holds the page, `n` and `p` turn it at once, and a page a key showed stays a whole interval. Ctrl-C and Ctrl-\\ end the view and Ctrl-Z stops it until `fg`, each giving the terminal back its modes; `--help` lists the keys. On Windows it reads no key and redraws every interval: Ctrl-C ends it, and Ctrl-\\ and Ctrl-Z do nothing, as Windows has no signal for either. `--once` prints one frame whole, as it does when stdout is not a terminal. `--interval` is a whole number of seconds from 1 to 3600, 5 by default |
| `logs` | Say where this box's runner log is read |
| `config` | Inspect or edit local config |
| `doctor` | Diagnose the environment (claude CLI, git, cred store, core reachability) |
| `service` | Install/uninstall the OS service (systemd/launchd) |
| `runners` | List runners registered for this device |
| `sync` | Pull the latest skills for bound projects now (one-shot) |
| `update` | Self-update from the release manifest |

### `top`'s SPEND — tokens and estimated cost per project

`top`'s SPEND section, the table's `$24H` column and each project's detail sum
the transcripts Claude Code writes under `~/.claude/projects` (each
`*/*.jsonl`, and `*/<session>/subagents/*.jsonl`) over the last 24 hours and 7
days: input, output, cache-write and cache-read tokens, and an estimated cost.
A response is counted once, keyed by `message.id` and `requestId`, at the
largest counts its lines carry. It belongs to the bound project whose checkout
holds the cwd it was written from; the master's own conversation (the ledger's
`masters.conversation_id`) is shown apart, and a cwd under no bound checkout is
listed as unattributed. Only the usage, model, time, ids and cwd of a line are
read, never its content, and nothing is written. A live view reads at most
1 GiB of transcript per redraw and says how far it has read until it has read
them all; `--once` reads them all first. It is a report: nothing is limited or
alerted on.

The cost comes from per-model rates in `config.toml`, in US dollars per million
tokens, keyed by the transcript's `message.model`:

```toml
[rates."claude-opus-5-5"]
input = 15
output = 75
cache_write = 18.75
cache_read = 1.5
```

A model with tokens and no rate, or a rate missing a key, is named, and every
cost leaving its tokens out says so (`$12.30 + <model> unpriced`, `$12+` in the
table); it is never priced as zero. Where no model in a window has a rate, the
cost reads `cost unread, <model> unpriced` (`$?+` in the table), never `$0.00`.

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
sha256, runs the download's `--version` and requires the version and commit the
release names, swaps the executable, and hands over to it in place.

Auto-update is **ON by default**. Once the new binary stands on disk the daemon
**hands over** to it: the same process replaces its own image with the installed
build (`exec`), keeping its pid, its service unit and the control socket, so no
run, pane or job is stopped and no second daemon ever serves the box (ISS-1379).
A re-login (a new device token) hands over the same way, to a fresh image of the
same build.

```
update applied ─▶ wait, admission OPEN ──────────────▶ closing window ─────▶ exec the build on disk
                  · in-process chat turns              · admission refused     · same pid, same unit
                  · parked chat sessions are             by name, ≤ 10s        · control listener carried
                    checkpointed and closed            · requests in flight      (FORGE_RUNNER_CONTROL_FD)
                  · runs in the ledger hold nothing      are answered first    · connections waiting in its
                  │                                                              backlog are answered by
                  └─ 2h and still held ─▶ deferred: admission open again,          the new build
                                          closed only for the closing windows
                                          it opened; nothing stopped; next
                                          update check / re-login
download refused ─▶ nothing installed: the file the kernel will not run, the one that exits before
                    saying what it is, the one naming another version or commit, are refused before
                    the rename, and the path keeps the build every hook and command runs
exec refused (unix) ─▶ the kept build goes back on the path, admission reopens, the old build goes on
                       serving, the log names the path tried (it is never run under /bin/sh)
not unix            ─▶ exit 0 for the service manager to start the new build, as before
```

- **Nothing reaches the path that has not run.** The download is written beside
  the binary and its `--version` run (10s bound) before it is renamed over it:
  every hook, every master's `forge-runner run declare` and every command a
  person types runs that path, so a file that cannot run would stop the box
  declaring anything until somebody reinstalled by hand. A refused download
  installs nothing and the next check refuses it again.
- **The served build is kept.** The daemon's first install links the build it
  serves to `<binary>.served`, and a handover whose exec does not happen puts
  it back on the path. The file outlives a handover that works, and the next
  update replaces it. `forge-runner update` from a shell keeps none: it restarts
  the unit rather than handing over.
- **The new image serves the masters at once.** Just before the exec the daemon
  writes the master panes it serves to `masters-handed.json` in its config
  directory; the image that starts takes it only under its own pid and boot and
  within two minutes, and removes it either way, so a master's declaration is
  answered from the first second rather than from its first sweep.
- **What it waits on is this process's own work**: chat turns and messages
  into master panes running inside the daemon, each named by its session or
  pane, and parked chat sessions, which are checkpointed and closed once per
  attempt (bounded by their 120s checkpoint budget). Only a session parked when
  that close began is closed: one started after it began, or sent a message
  after it began, is left open and not counted. A message sent to a session
  whose turn is in flight, a save request's included, waits for that turn to
  end and is answered by its own reply; the runner logs that it waited, and
  refuses it by name if the session ends first. Runs in the ledger, bound or not,
  are not holders: they live in their panes, which the new image adopts, and
  their masters bind, answer for and close them across the handover.
- **Admission stays open while it waits.** Runs are declared, pool jobs taken,
  masters placed and nudged. It is refused only inside a closing window — each
  at most 10s, and an attempt that finds work still in flight at the end of one
  opens another, so the time admission is closed in one attempt is not bounded
  by 10s — with a reason that says the box is handing over and that nothing was
  recorded.
- **It speaks while it waits**: a line at the start and every 10 minutes naming
  each turn it waits on and how long it has run, in whichever step it is —
  between looks, while the parked sessions close, or inside a closing window,
  whose line says admission is closed for it. `forge-runner status` says a
  waiting handover keeps admission open, and gives each turn's running time as
  of the moment it is run.
- **It is bounded at 2h of clock time** from the moment it began. A step under
  way when the bound passes — a closing window, or the close of parked
  sessions, followed where it leaves the box idle by the one closing window
  that would hand over — runs to its end, and the give-up comes at the look
  after it, so `status` says a waiting handover gives up at its first look
  past 2h rather than that it waits at most 2h. In-process work that outlasts that defers the
  handover — admission is open again, and the give-up line says how many
  closing windows closed it on the way, or that none did, and how long it
  really waited — and no handover is attempted again for 2h. The next
  attempt is the next update check, or the next re-login.
- **Nothing is announced before it begins.** The update loop's line says the
  new release stands on disk and which build this process serves; the
  re-login line says the token changed. Whether a handover then waits, begins
  or is refused is said by the handover's own lines.
- **Masters an update leaves behind are outdated.** A pane loads its hooks,
  skill and plugins once, so the panes the new image adopts still run what they
  were placed under. The daemon records the runner build and the installed
  Claude Code plugin set at every placement; a pane placed under another build,
  another plugin set, or before the build was recorded is outdated. An outdated
  pane is not nudged, and the journal says so once per pane and reason. It is
  ended and placed again — in the same sweep, resuming its conversation — only
  when it holds no open run under the session this box serves it as (written
  onto its ledger row with the carry; a pane whose row names another, or whose
  carry left a run it could not read, is left running until that clears), its
  turn is affirmatively over (its hooks say so,
  or, unheard since the handover, its transcript's newest entry is a turn's
  end), its project has admissible work, and the conversation its row records
  has a transcript to resume (a successor without one starts cold). Otherwise
  it is left running and the journal names every reason that holds and
  `forge-runner master kill <slug>`, which replaces it now. The pane placed in
  its stead takes its brief as this sweep's nudge, and is nudged from the next. `forge-runner top` prints `OUTDATED` under that master with both builds
  or plugin sets.
- **A declaration nothing binds is ended at 60 minutes.** A run declared and
  never bound to a subagent or a process holds its issues' leases and its
  master's one unbound slot; after an hour (every bound run measured on the
  fleet bound within 51 minutes) the box ends it naming its age, and the close
  loop returns its session and leases as it would after its master's close.

The first update INTO this behaviour is still taken by the build being replaced,
which drains the way that build does.

Until the handover, the daemon serves the build it started on while the newer
file stands on disk. `forge-runner status` prints both — `binary` for the file,
`daemon` for what the running daemon recorded it serves, with its handover — and
`forge-runner --version` adds a line on stderr when the two differ, leaving its
stdout unchanged. Both compare the two versions: only where this binary's is the
higher does either say the daemon has not restarted onto it and advise a
restart. A daemon on a higher version than the binary run is named as the newer
build, and two builds of one version cannot be ordered, so neither advises one.

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
being the latest is exactly the state a deferred handover leaves — updated, not yet
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

- **It never cuts into a handover that is under way.** A daemon handing over
  replaces itself once its in-process work ends, so a restart there would cut
  exactly that work. It names the cause and what it waits on instead, and leaves
  the box to turn itself over. A handover that was deferred is the opposite case
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

The stamped commit is the one on `main` that **brought the newest runner change in**
(`scripts/runner-release-commit.mjs`): the merge for a pull request merged with a
merge commit, the commit itself for a push made straight to `main` or a rebased
series. It is neither the head of the push, which can hold a runner commit followed
by an unrelated one, nor the pull request's own last commit, which a build of `main`
cannot be shown to contain the merge of — a verification `--contains <merge>` is
answered against this commit. Core reads a release against the branch by
containment: a release carries what landed when its commit is the newest commit that
touched `packages/runner` or a descendant of it. A commit some release already
carries is refused rather than released again — a rerun of an older release job
would otherwise publish that code under a version higher than what followed it.

Withdrawing a release takes two acts, not one: core's
`packages/core/src/install/fetch-release.ts` never moves `RUNNER_RELEASE_DIR` backwards,
so deleting a tag and its GitHub Release leaves
the bad build still being served. Either delete `VERSION` and the
`forge-runner-*` assets from that directory on the core host, or publish a higher
corrective release — then read `/api/install/latest.json` back before reinstalling
anything.
