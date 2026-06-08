# Release process

How Forge Beta (Tauri desktop app) gets built, signed, published, surfaced on `/download`.

**Audience:** maintainers cutting an official release. Source builders skip this — run `pnpm tauri build` directly.

## TL;DR

Use the release skill: bumps every version file in lockstep, promotes `## [Unreleased]` CHANGELOG → `## [X.Y.Z]`, tags, pushes, with atomic preflight rejecting version mismatches.

```bash
/forge-cut-release X.Y.Z --headline "..."
# or invoke the script directly from the repo root:
.claude/skills/forge-cut-release/scripts/cut-release.sh X.Y.Z
```

- Never bump by hand — files must move together ([Versioning](#versioning)); manual edits drift.
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

- Pre-`1.0` semver — `v0.X.Y` while in alpha.
- Tags must match `v*.*.*` exactly (workflow trigger pattern).
- Pre-release suffix (`v0.1.16-rc.1`) marks GitHub Release as pre-release automatically.

Whole monorepo shares one version. The `cut-release.sh` script (in the maintainer's `forge-cut-release` skill, not shipped in this repo) bumps these in lockstep — canonical set:

| File | Field |
|---|---|
| `package.json` (root) | `version` |
| `packages/core/package.json` | `version` |
| `packages/contracts/package.json` | `version` |
| `packages/observability/package.json` | `version` |
| `packages/web-v2/package.json` | `version` |
| `packages/dev/package.json` | `version` |
| `packages/dev/src-tauri/tauri.conf.json` | `version` |
| `packages/dev/src-tauri/Cargo.toml` | `[package].version` |
| `packages/runner/Cargo.toml` | `[workspace.package].version` |

Preflight is **atomic**: after bumping runs `jq -r .version <all json files> | sort -u`, aborts unless one line — a mismatch can never reach a tag (mismatch also breaks the in-app updater, so the gate is hard not advisory). Hence `/forge-cut-release` over hand-editing.

## CHANGELOG

`release.yml` extracts the section under `## [X.Y.Z] - YYYY-MM-DD` from `CHANGELOG.md` as release notes body. Format must be exactly:

```markdown
## [0.1.16] - 2026-04-30

### Added
- Thing.

### Fixed
- Other thing.
```

No matching section → workflow falls back to GitHub's auto-generated commit-list.

### Writing changelog entries — style guide

Each entry reaches end users (in-app updater changelog) AND developers (GitHub release page). Must read first as a release note for someone who never opened the repo, with technical depth on second pass.

- **Lead with user-visible outcome, not implementation.**
  - ✅ *"The pipeline now uses ~30% fewer tokens per issue — your monthly cost on the same workload drops."*
  - ❌ *"`buildPipelinePreamble` in `chat-preamble.ts` now ships `PIPELINE_RULES` + `TOOL_REFERENCE` for prompt-cache hits."*
- **One concept per bullet.** Two "and"s → split. Don't bury a fix in a feature bullet — different `###` sections (`### Added` vs `### Fixed`).
- **Plain language first sentence; code in a sub-line.** Tool/function names, file paths, migration numbers go in an italic `*Technical:*` sub-line. Skip the sub-line if there's no useful debugging breadcrumb.
- **Numbers > adjectives.** "~30% fewer tokens" beats "much faster". "Dropped from $1.42 to $0.45" beats "significantly cheaper". No number → name the surface the user sees changed (e.g. "the Insights → Cost page" not "metrics").
- **No internal jargon in the user-facing sentence.** Avoid "legacy device path", "Wave 1", "PR-B", `ISS-NNN`, "the L2 dispatcher gate" — fine inside `*Technical:*`. Feature exists because of a removed system → name the user-visible replacement, not the old internal name.
- **One headline per release.** First line under `## [X.Y.Z]` is 1–2 plain-language sentences on why a user would update. Lead with user benefit, ideally one concrete number.

#### Template

```markdown
## [X.Y.Z] - YYYY-MM-DD

<headline — 1–2 sentences in plain language. Mention numbers where you have them.>

### Added | Changed | Fixed | Removed | Security

- **<Plain user-facing summary in 1 sentence.>** <Why it matters / what they'll see — 1 more sentence, optional.>
  *Technical: file paths, function names, migration numbers, root cause. Optional — include only when useful for debugging.*
```

#### Worked example

```markdown
## [0.1.34] - 2026-05-21

The pipeline now uses ~30–60% fewer tokens per issue thanks to smarter server-side prompt caching, and the cost dashboard finally shows real numbers (it used to display $0 on every step).

### Fixed

- **The Insights → Cost dashboard now shows actual spend per pipeline step.** Every triage / plan / code / review / test / release / fix row used to report $0 USD regardless of real cost. The next issue your worker handles will populate real numbers within seconds.
  *Technical: `usage_records.session_id` was storing the local Tauri job id instead of the forge `agent_sessions.id`, so the `pipeline_run_step_durations` view JOIN never matched. Accumulator + POST moved to `use-web-socket.ts`'s pipeline-complete handler, keyed by the forge UUID surfaced on `job.assigned`.*
```

Two-pass rule: a non-developer reading only the bold first sentence of every bullet knows what the release does for them; a developer reading the *Technical:* lines knows where to start debugging.

## Testing a release without publishing

Push a pre-release tag — workflow runs, but `prerelease: true` keeps it from competing with latest stable for `/download`'s "latest" lookup:

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
| `/download` page falls back to "Build from source" after a successful release | Release still Draft because publish job didn't run | Inspect the `build` matrix — every job must succeed |
| Updater can't fetch `latest.json` | `tauri-action` ran without `includeUpdaterJson: true` or signing key missing | Verify the JSON exists in release assets and matches the pubkey in `tauri.conf.json` |
