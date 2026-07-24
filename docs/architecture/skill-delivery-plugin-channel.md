# Skill delivery, channel 3: the plugin marketplace (ISS-739)

> Canonical model + decisions: [skill-delivery.md](skill-delivery.md) (ADR). This doc is the channel-3 mechanism detail.

Forge delivers pipeline skills to a job's Claude Code process through three
independent channels. This doc covers the third — a Claude Code **plugin**,
distributed via a git-repo **marketplace**, installed once per device by the
runner. The other two channels are established elsewhere and are not changed
by this work:

| # | Channel | Scope | Mechanism |
|---|---------|-------|-----------|
| 1 | Disk, per-project | Per-project shadow/override skills | `workspace/skill_sync.rs` — server pushes the effective manifest, the runner seeds `.claude/skills/<name>/` into the job's worktree on every job (ISS-278). Also carries `install_only` fan-out (ISS-737) for shared skills that a project hasn't customized. |
| 2 | MCP-served | Meta, read-only prompts | Served live over the project's `/mcp` connection — no on-disk copy. |
| **3** | **Plugin marketplace** | **Shared/global skills** | **This doc.** Installed once per device via `claude plugin`; every job on that device inherits it for free. |

## Role split (doctrine)

- **Shared/global skills** → plugin (channel 3). One install serves every
  project on the device.
- **Per-project shadow/override skills** → disk (channel 1, unchanged).
  `install_only` (ISS-737) keeps working in parallel — see "Deferred: retiring
  install_only" below.
- **Meta, read-only skills** → MCP (channel 2, unchanged).

## Why device-level plugin install reaches every job

Every pipeline job spawns `claude -p` via `runner/process.rs::build_command`,
which does **not** set `CLAUDE_CONFIG_DIR` — the child inherits whatever
config dir the daemon process itself resolves to (`$CLAUDE_CONFIG_DIR` if the
operator set one, else `~/.claude`). A plugin installed into that same config
dir, once, by the daemon's background sweep, is therefore visible to every job
the daemon dispatches — no per-project sync, no per-job copy step. This was
verified in-session: a plugin's slash-commands load and invoke correctly
under headless `claude -p --strict-mcp-config`, independent of the MCP-connect
timing race that affects MCP-*served* prompts (see
`skill/mcp-prompt-slash-command-p-mode-timing` in project memory) — disk- and
plugin-loaded slash commands are read at CLI init regardless of MCP state.

This channel is purely additive: `build_args` / the `-p` exec path are
untouched, and no `CLAUDE_CONFIG_DIR` is introduced.

## Mechanism

`packages/runner/crates/forge-runner-core/src/workspace/plugin_sync.rs::ensure_plugins`,
invoked by a daemon background sweep
(`packages/runner/crates/forge-runner-core/src/daemon/mod.rs`) with a jittered
(≤10min) initial delay after startup, then periodically at
`plugins.poll_interval_secs` (default 6h) — modeled on the existing 90s
workspace-provisioning sweep. Every step is best-effort: it logs and moves on,
it never panics, so a flaky network or an already-satisfied precondition
(marketplace already added, plugin already installed) can't wedge the sweep.

Per cycle, when `plugins.enabled` (config: `[plugins]` in
`~/.config/forge-runner/config.toml`):

1. `claude plugin marketplace add <marketplace_repo> --scope user` — idempotent;
   an "already added" failure is logged at `info` and ignored.
2. If `plugins.pinned_ref` is set, checkout that commit SHA (detached HEAD) in
   the marketplace's local git clone. See "The SHA-pin decision" below for why
   this lives here instead of in `marketplace.json`.
3. For each configured `plugins.plugin_names`: `claude plugin install
   <plugin>@<marketplace> --scope user`, then `claude plugin enable <plugin>
   --scope user` (install does **not** auto-enable — confirmed against a live
   `claude plugin list --json`, which reports `"enabled": false` right after
   install).
4. If `plugins.auto_update` (default **on**): `claude plugin marketplace
   update <marketplace>` followed by `claude plugin update <plugin>` for each
   configured plugin.

### The SHA-pin decision (OQ1, resolved)

Claude Code's plugin schema has no SHA field for a marketplace's own
`marketplace.json` — a repo-relative `source: "./"` entry simply has nothing
to pin. Confirmed live against `claude plugin --help` / `claude plugin
marketplace --help` / `claude plugin install --help` (installed version
2.1.218): none of `marketplace add`, `install`, or `update` accept a ref/SHA
argument.

The pin therefore lives in **runner provisioning**
(`plugins.pinned_ref`), applied by checking out that commit in the
marketplace's local clone. This works because `claude plugin install` does
not reference the marketplace clone live — it **copies** a snapshot into
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` at install time
(confirmed against `~/.claude/plugins/installed_plugins.json`, which records
a `gitCommitSha` per installed plugin). Checking out the pin before `install`
makes that snapshot deterministic.

**Interaction with `auto_update`:** the pin is a *floor*, not a permanent
lock. It guarantees the very first install (or any cycle where `auto_update`
is off) lands on a known-good commit. When `auto_update` is on — the default,
per owner decision, for the first-party Forge marketplace — step 4 runs
`marketplace update` right after the pin is applied, which fast-forwards the
clone past it on every successful cycle. This mirrors "poll + jitter +
auto-update" doctrine (decision #3): the pin exists for deterministic canary
rollout, not for freezing a device on one commit forever. An operator who
wants a hard, permanent pin sets `auto_update = false`.

### Resolving the marketplace's registered name

`claude plugin marketplace add` lets the CLI choose the registered name
(typically the marketplace manifest's own `name` field, not necessarily the
repo slug — e.g. `SidCorp-co/forge-pipeline-skills` registers as `forge`).
Subsequent commands (`install <plugin>@<marketplace>`, `marketplace update
<name>`) need that name, so `plugin_sync` resolves it by matching the
configured `marketplace_repo` against
`<claude-config-dir>/plugins/known_marketplaces.json`'s `source.repo` field.

This file is a CLI-internal cache, not a documented public contract — if its
shape changes upstream, resolution degrades gracefully: `find_marketplace`
returns `None`, a warning is logged, and subsequent steps fall back to the
bare plugin name / an un-scoped `marketplace update` (updates all configured
marketplaces on the device, a broader but safe no-op-if-unchanged operation).

## Canonical `forge-pipeline-skills` layout

The external marketplace repo (`github.com/SidCorp-co/forge-pipeline-skills`)
already has `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`
(v0.2.0), so the runner mechanism above works against it today. Its current
`plugin.json` bundles skills by **project profile**
(`pnpm-monorepo-tbd-local`, `webapp-coolify-gitflow`) rather than as a single
shared-skills unit. The canonical shape this issue specifies for that repo
(a follow-up in that repo, out of this diff — see below):

- `.claude-plugin/marketplace.json` — `source: "./"`, one entry per plugin.
- A `forge-shared-skills` plugin (or one plugin per shared-skill group) that
  bundles the skills meant for channel 3 (shared/global), distinct from any
  project-profile bundle that stays purely illustrative/example content.
- Plugin `plugin.json` version bumped on every skill-content change so
  `installed_plugins.json`'s `version` field stays a meaningful signal.

The runner side is layout-agnostic: it only needs *some* plugin name(s) in
`plugins.plugin_names` that resolve against the marketplace, so the reorg
does not block this slice and can land independently.

## Canary rollout

`plugins.enabled` defaults to **false**. The runner binary ships to every
paired device via the existing Rust release channel — there is no per-device
gating at that layer — so this feature must default off and be turned on
explicitly:

```toml
[plugins]
enabled = true
marketplace_repo = "SidCorp-co/forge-pipeline-skills"
plugin_names = ["forge-shared-skills"]
pinned_ref = "<known-good-sha>"
auto_update = true
poll_interval_secs = 21600
```

Enable on one device first (`forge-runner config` or hand-edit
`~/.config/forge-runner/config.toml`, then restart), confirm the plugin's
skills load in a real job, then widen.

## Deferred: retiring `install_only` (OQ2)

ISS-737's per-project `install_only` disk fan-out (channel 1) is **not**
removed by this issue. Per owner direction, both channels run in parallel
until the plugin channel is proven in production. A `relates` follow-up
(filed as `draft`, linked to ISS-737) will scope the actual rip-out for
skills that migrate to shared/global-via-plugin. Until that follow-up lands,
a skill can legitimately be delivered by both channel 1 (as a per-project
override) and channel 3 (as the shared default) — channel 1 always wins for
a project that has an explicit shadow copy, since it's seeded directly into
the job's worktree.

## Non-goals

- The MCP-served-prompt timing issue under `-p` (a different, unrelated
  lever) is out of scope — see project memory
  `skill-delivery/lever-order-and-mcp-p-fix-deferred`.
- The shared job exec path (`build_args` / `-p` invocation) is untouched.
- No `CLAUDE_CONFIG_DIR` is introduced anywhere in this change.
