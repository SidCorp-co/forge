# Release process

How Forge Beta (Tauri desktop app) gets built, signed, published to the GitHub Release page.

**Audience:** maintainers cutting an official release. Source builders skip this — run `pnpm tauri build` directly.

## TL;DR

Use the release skill for the **desktop** app: bumps the desktop version files in lockstep, promotes `## [Unreleased]` CHANGELOG → `## [X.Y.Z]`, tags `vX.Y.Z`, pushes, with atomic preflight rejecting version mismatches. **Runner** and **cloud** version independently — see [Versioning](#versioning) for the three domains and when to bump N1.N2.N3.

```bash
/forge-cut-release X.Y.Z --headline "..."
# or invoke the script directly from the repo root:
.claude/skills/forge-cut-release/scripts/cut-release.sh X.Y.Z
```

- Never hand-bump the desktop files — they must move together ([Versioning](#versioning)); manual edits drift the updater.
- Pushing the `vX.Y.Z` tag triggers `.github/workflows/release.yml`. ~15-20 min later:
  - Draft GitHub Release created, notes from `CHANGELOG.md`.
  - `tauri-action@v0` builds + signs + uploads on macOS (Intel + ARM), Windows, Linux.
  - Tauri updater manifest `latest.json` generated alongside bundles.
  - Publish job flips release to non-draft.
  - No in-app `/download` page: the old `web-v1` `/download` route was dropped and not ported to `web-v2`. Users grab bundles from the GitHub Release page directly; `core/src/install/fetch-release.ts` reads the Releases API only to pull the latest `runner-v*` binary, not the Tauri desktop bundles.
- Build job fails → release stays Draft, publish skipped. Logs: `gh run list -R <owner>/<repo> --workflow=release.yml`.

## Pipeline shape

```
push tag vX.Y.Z
   ↓
release job          create draft GitHub Release with changelog notes
   ↓
build matrix (4)     ubuntu-22.04 / macos-arm64 / macos-x64 / windows
   ↓                 each: install deps → tauri-action build + sign + upload
publish job          gh release edit --draft=false
```

Matrix `fail-fast: false` — Windows failure won't kill macOS jobs. But **publish** needs *all* builds; partial success leaves release Draft.

## Required secrets

Set in GitHub: **Settings → Secrets and variables → Actions → Secrets**.

### Always required

| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Output of `pnpm tauri signer generate -w ~/.tauri/forge.key`. Sign-once for the lifetime of the app — rotating breaks updates for installed users. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase chosen at generate time. |

Matching public key: [`packages/dev/src-tauri/tauri.conf.json:pubkey`](../../packages/dev/src-tauri/tauri.conf.json) — what the in-app updater verifies against.

### Optional — macOS code signing + notarization

Without these: builds succeed but `.dmg` shows *"can't be opened — unidentified developer"* on first launch (right-click → Open to bypass once). To enable: enroll Apple Developer Program ($99/yr), create *Developer ID Application* cert, export as `.p12`.

| Secret | How to get it |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12 \| pbcopy` (macOS) |
| `APPLE_CERTIFICATE_PASSWORD` | password set during `.p12` export |
| `APPLE_SIGNING_IDENTITY` | exact identity name, e.g. `Developer ID Application: Acme Inc (ABCDE12345)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password from [appleid.apple.com](https://appleid.apple.com/) → *Sign-In and Security → App-Specific Passwords* |
| `APPLE_TEAM_ID` | 10-char Team ID from [developer.apple.com](https://developer.apple.com/) → *Membership* |

`tauri-action` autodetects these env vars, runs `codesign` + `xcrun notarytool submit`. No `tauri.conf.json` config needed.

### Optional — Windows code signing

Without these: builds succeed but SmartScreen shows *"Windows protected your PC"* on first launch (More info → Run anyway). SmartScreen reputation builds over time; an EV cert short-circuits this. Cert vendors: Certum (~$150/yr OV), Sectigo (~$300/yr OV, ~$400/yr EV), DigiCert. EV certs require a hardware token.

| Secret | How to get it |
|---|---|
| `WINDOWS_CERTIFICATE` | `base64 cert.pfx > cert.b64` then paste contents |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` password |

## Versioning

Forge ships **three independently-versioned artifacts**. They are NOT one shared
monorepo number — each has its own release cadence, tag, and version files. A
change to one never bumps another (so a runner release can't downgrade the
desktop version, and a cloud deploy doesn't force a desktop release).

### The three version domains

| Domain | What | How it ships | Tag | Version files (the domain owns these) |
|---|---|---|---|---|
| **desktop** | Tauri app (`packages/dev`) | `release.yml` builds + signs bundles; in-app updater | `vX.Y.Z` | `packages/dev/package.json`, `packages/dev/src-tauri/tauri.conf.json`, `packages/dev/src-tauri/Cargo.toml` |
| **runner** | headless CLI daemon (`packages/runner`) | `runner-release.yml` builds binaries; install.sh + auto-update channel | `runner-vX.Y.Z` | `packages/runner/Cargo.toml` (`[workspace.package].version`) |
| **cloud** | core + web-v2 (forge-beta) | continuous deploy from `main` via Coolify | *(none — commit-identified)* | `package.json` (root), `packages/core`, `packages/contracts`, `packages/observability`, `packages/web-v2` `version` |

- **desktop** + **runner** are tag-driven releases (CI builds an artifact). The
  tauri version files MUST stay in sync (updater verifies); `forge-cut-release`
  enforces that atomically.
- **cloud** has no build artifact — it's identified by `SOURCE_COMMIT`, deployed
  on every push to `main`. Its `version` is **display-only** (`forge_version`),
  bumped independently when you want to mark a notable cloud release (edit the 5
  files together; an optional `web-vX.Y.Z` tag may mark the commit — no CI). It
  is never bumped by the desktop release.
- All three are independent: e.g. desktop `0.3.x`, runner `0.6.x`, cloud `0.3.x`
  can legitimately coexist.

### When to bump N1.N2.N3 (per domain — SemVer)

Each domain's version is `MAJOR.MINOR.PATCH`. Bump the element by the **most
significant** kind of change in the release:

| Element | Bump when… | Post-1.0 | Currently (0.x) |
|---|---|---|---|
| **N1** MAJOR | the artifact's contract breaks (see below) | → N1, reset N2/N3 to 0 | held at **0** until the artifact declares a stable 1.0 contract |
| **N2** MINOR | a new backward-compatible capability is added | → N2, reset N3 to 0 | **breaking OR new capability** → N2 |
| **N3** PATCH | only backward-compatible fixes / internal changes | → N3 | fixes only → N3 |

> **Pre-1.0 rule (where we are now):** while MAJOR = `0`, SemVer treats the API as
> unstable, so **both** breaking changes and new capabilities bump **N2**; only
> pure fixes bump **N3**. (Example: provisioning was a new capability → runner
> `0.5.0` → `0.6.0`.) Promote a domain to `1.0.0` only when committing to its
> contract stability; after that, breaking → N1.

**What "breaking" means per domain:**
- **desktop** — a data-dir / config / updater-state migration that an installed
  user can't roll back through.
- **runner** — a core⇄runner wire-protocol or auth change incompatible with an
  older core, or a CLI / `config.toml` change that requires manual user action.
- **cloud** — a `packages/contracts` REST/WS change that breaks an existing
  client (desktop, runner, or web) it must serve.

### Cutting each release

- **desktop:** `/forge-cut-release X.Y.Z --headline "..."` → bumps the 3 desktop
  files in lockstep, promotes CHANGELOG, tags `vX.Y.Z`, pushes. Atomic preflight:
  `jq -r .version <desktop json> | sort -u` must be one line (a mismatch breaks
  the updater, so the gate is hard). It does **not** touch runner or cloud files.
- **runner:** bump `packages/runner/Cargo.toml` `[workspace.package].version`
  (the runner's `agentVersion` = `CARGO_PKG_VERSION`, which drives auto-update),
  `cargo build` to refresh `Cargo.lock`, commit, then `git tag runner-vX.Y.Z &&
  git push origin runner-vX.Y.Z` → `runner-release.yml`.
- **cloud:** deployed by commit; bump the 5 cloud `version` fields together only
  to mark a notable release (display-only).

### CHANGELOG

There is **one** `CHANGELOG.md`, keyed to the **desktop** release `## [X.Y.Z]`
(it feeds the desktop in-app updater + GitHub Release). Runner and cloud releases
do not get their own `## [...]` sections — note runner-facing changes in the
`runner-vX.Y.Z` GitHub Release body, and cloud changes in commit/PR history.

Tags must match their pattern exactly (`v*.*.*` / `runner-v*`). A pre-release
suffix (`v0.3.1-rc.1`) marks the GitHub Release as pre-release automatically.

## CHANGELOG

`release.yml` extracts the section under `## [X.Y.Z] - YYYY-MM-DD` from `CHANGELOG.md` as release notes body. Format is exactly a headline line + a flat bullet list:

```markdown
## [0.1.16] - 2026-04-30

Short headline — why a user would update.

- Fixed a thing users saw.
- Added a thing users can now do.
```

No matching section → workflow falls back to GitHub's auto-generated commit-list.

### Writing changelog entries — style guide

The CHANGELOG is the **end-user release note** (it feeds the in-app updater and the GitHub Release page). Optimise it for a person who never opened the repo and is scanning to decide whether to update. **Keep it flat and terse, like the Claude Code CLI changelog.**

- **One line per change. No `*Technical:*` sub-line, no bold, no sub-bullets.** The technical detail (file paths, functions, migration numbers, root cause, `ISS-NNN`, merge SHA) lives in the **commit body and the PR** — that's the developer's trail, and duplicating it here is what made the changelog a wall of text. The changelog never repeats it.
- **Lead with the user-visible outcome, in plain language.** Start with a verb where natural (`Fixed…`, `Added…`, or just describe the new behaviour). Past or present tense, ≤ ~120 chars.
  - ✅ `Fixed agent chat failing to send when a runner was online`
  - ✅ `Pipeline uses ~30% fewer tokens per issue`
  - ❌ `buildPipelinePreamble now ships PIPELINE_RULES + TOOL_REFERENCE for cache hits`
- **One concept per bullet.** Two "and"s → split into two bullets.
- **Numbers > adjectives.** "~30% fewer tokens" beats "much faster"; "$1.42 → $0.45" beats "cheaper". No number → name the surface the user sees (e.g. "the Cost page", not "metrics").
- **No internal jargon.** No "legacy device path", "Wave 1", "PR-B", `ISS-NNN`, "L2 dispatcher gate". Name the user-visible thing, not the internal system it replaced.
- **Flat — no `### Added/Fixed` sections.** A single scannable list under the version. (Optionally prefix a bullet with an area, Claude-Code-style: `Runners: …`, `Chat: …` — only when it aids scanning.)
- **One headline per release.** The line right under `## [X.Y.Z]` is 1–2 plain sentences on why a user would update — ideally with one concrete number. This is also the `--headline` the in-app updater shows.

#### Template

```markdown
## [X.Y.Z] - YYYY-MM-DD

<headline — 1–2 plain sentences, a number if you have one>

- <One user-facing line. What changed, for the user. No file paths, no SHAs.>
- <Next change, one line.>
```

#### Worked example

```markdown
## [0.1.34] - 2026-05-21

Pipeline uses ~30–60% fewer tokens per issue, and the cost dashboard now shows real numbers (it used to read $0 on every step).

- Fixed the Cost dashboard showing $0 on every pipeline step — real spend now populates within seconds
- Pipeline uses ~30–60% fewer tokens per issue via smarter server-side prompt caching
```

Where the technical detail goes: the commit that lands the change. Its body carries the root cause, files, migration numbers — so `git log` / the PR is the developer trail, and the CHANGELOG stays the user's.

## Testing a release without publishing

Push a pre-release tag — workflow runs, but `prerelease: true` keeps it from competing with latest stable for the GitHub Release "latest" lookup:

```bash
git tag v0.1.16-rc.1
git push origin v0.1.16-rc.1
```

Re-tag with the stable name once artifacts look right.

## Rollback / emergency unpublish

```bash
gh release delete vX.Y.Z --repo SidCorp-co/forge --cleanup-tag
```

`--cleanup-tag` removes the git tag too. Installed users on this version stay (no auto-downgrade); the next valid release published as Latest takes over the updater channel.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| All 4 build jobs die at "Setup pnpm" with *Multiple versions of pnpm specified* | `pnpm/action-setup` `version:` field set + `packageManager` in `package.json` | Drop the `version:` from the workflow; let `packageManager` win. |
| Lockfile-related cache miss on every run | `cache-dependency-path` points at a non-existent path | Should be `pnpm-lock.yaml` (root); `packages/dev/pnpm-lock.yaml` doesn't exist (workspace) |
| macOS build succeeds but `.dmg` rejected by Gatekeeper | Notarization not stapled | Confirm all six `APPLE_*` secrets set; check `notarytool` output in logs |
| GitHub Release shows no downloadable bundles after a successful release | Release still Draft because publish job didn't run | Inspect the `build` matrix — every job must succeed |
| Updater can't fetch `latest.json` | `tauri-action` ran without `includeUpdaterJson: true` or signing key missing | Verify the JSON exists in release assets and matches the pubkey in `tauri.conf.json` |
