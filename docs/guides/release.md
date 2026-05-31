# Release process

> **Audience:** maintainers cutting an official release. End users building from source do not need to follow this — they can run `pnpm tauri build` directly.

How a new version of Forge Beta (the Tauri desktop app) gets built, signed, published, and surfaced on `/download`.

## TL;DR

Use the release skill — it bumps every version file in lockstep, promotes the
`## [Unreleased]` CHANGELOG section to `## [X.Y.Z]`, tags, and pushes, with an
atomic preflight that rejects version mismatches:

```bash
/forge-cut-release X.Y.Z --headline "..."
# or invoke the script directly from the repo root:
.claude/skills/forge-cut-release/scripts/cut-release.sh X.Y.Z
```

Do **not** bump versions by hand — the files must move together (see
[Versioning](#versioning)) and manual edits drift. Pushing the `vX.Y.Z` tag is
what triggers `.github/workflows/release.yml`.

That triggers `.github/workflows/release.yml`. ~15-20 min later:

- A draft GitHub Release is created with notes lifted from `CHANGELOG.md`.
- `tauri-action@v0` builds + signs + uploads artifacts on macOS (Intel + ARM), Windows, Linux.
- Tauri's updater manifest (`latest.json`) is generated alongside the bundles.
- The publish job flips the release to non-draft.
- The `/download` page (in `packages/web`) reads GitHub Releases API and shows the new bundles automatically — no redeploy needed.

If a build job fails, the release stays Draft and the publish job is skipped. Inspect logs at `gh run list -R <owner>/<repo> --workflow=release.yml`.

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

Matrix is `fail-fast: false` — a Windows failure won't kill the macOS jobs. But the **publish** job needs *all* builds to succeed; partial success leaves the release Draft.

## Required secrets

Set in GitHub: **Settings → Secrets and variables → Actions → Secrets**.

### Always required

| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Output of `pnpm tauri signer generate -w ~/.tauri/forge.key`. Sign-once for the lifetime of the app — rotating breaks updates for installed users. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passphrase chosen at generate time. |

The matching public key lives at [`packages/dev/src-tauri/tauri.conf.json:pubkey`](../../packages/dev/src-tauri/tauri.conf.json) and is what the in-app updater verifies against.

### Optional — macOS code signing + notarization

Without these, builds succeed but the `.dmg` shows *"can't be opened — unidentified developer"* on first launch. Users right-click → Open to bypass once.

To enable: enroll in the Apple Developer Program ($99/yr), create a *Developer ID Application* certificate, export as `.p12`.

| Secret | How to get it |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12 \| pbcopy` (macOS) |
| `APPLE_CERTIFICATE_PASSWORD` | password set during `.p12` export |
| `APPLE_SIGNING_IDENTITY` | exact identity name, e.g. `Developer ID Application: Acme Inc (ABCDE12345)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password from [appleid.apple.com](https://appleid.apple.com/) → *Sign-In and Security → App-Specific Passwords* |
| `APPLE_TEAM_ID` | 10-char Team ID from [developer.apple.com](https://developer.apple.com/) → *Membership* |

`tauri-action` autodetects these env vars and runs `codesign` + `xcrun notarytool submit` for you. No further config in `tauri.conf.json` needed.

### Optional — Windows code signing

Without these, builds succeed but Windows SmartScreen shows *"Windows protected your PC"* on first launch. Users click *More info → Run anyway*. SmartScreen reputation builds over time; an EV cert short-circuits this.

Cert vendors: Certum (~$150/yr OV), Sectigo (~$300/yr OV, ~$400/yr EV), DigiCert. EV certs require a hardware token.

| Secret | How to get it |
|---|---|
| `WINDOWS_CERTIFICATE` | `base64 cert.pfx > cert.b64` then paste contents |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` password |

## Versioning

The repo uses pre-`1.0` semver — `v0.X.Y` while in alpha. Tags must match `v*.*.*` exactly (workflow trigger pattern). Pre-release suffix (`v0.1.16-rc.1`) marks GitHub Release as pre-release automatically.

The whole monorepo shares one version. `cut-release.sh` bumps these files in
lockstep — this list is the canonical set
([`.claude/skills/forge-cut-release/scripts/cut-release.sh`](../../.claude/skills/forge-cut-release/scripts/cut-release.sh)):

| File | Field |
|---|---|
| `package.json` (root) | `version` |
| `packages/core/package.json` | `version` |
| `packages/contracts/package.json` | `version` |
| `packages/observability/package.json` | `version` |
| `packages/web/package.json` | `version` |
| `packages/dev/package.json` | `version` |
| `packages/dev/src-tauri/tauri.conf.json` | `version` |
| `packages/dev/src-tauri/Cargo.toml` | `[package].version` |
| `packages/runner/Cargo.toml` | `[workspace.package].version` |

The script's preflight is **atomic**: after bumping it runs
`jq -r .version <all json files> | sort -u` and aborts unless that yields a
single line, so a mismatch can never reach a tag. (A mismatch also makes the
in-app updater misbehave — another reason the gate is hard, not advisory.) This
is why you run `/forge-cut-release` rather than editing the files by hand.

## CHANGELOG

`release.yml` extracts the section under `## [X.Y.Z] - YYYY-MM-DD` from `CHANGELOG.md` as the release notes body. Format must be exactly:

```markdown
## [0.1.16] - 2026-04-30

### Added
- Thing.

### Fixed
- Other thing.
```

If no matching section is found, the workflow falls back to GitHub's auto-generated commit-list.

### Writing changelog entries — style guide

The same CHANGELOG entry reaches end users (via the in-app updater changelog) AND developers (via the GitHub release page). It must read first as a release note for someone who has never opened the repo, with technical depth available on a second pass.

**Lead with the user-visible outcome, not the implementation.**

- ✅ *"The pipeline now uses ~30% fewer tokens per issue — your monthly cost on the same workload drops."*
- ❌ *"`buildPipelinePreamble` in `chat-preamble.ts` now ships `PIPELINE_RULES` + `TOOL_REFERENCE` for prompt-cache hits."*

**One concept per bullet.** If you have to say "and" twice, split it. Don't bury a fix inside a feature bullet — they belong in different `###` sections (`### Added` vs `### Fixed`).

**Plain language in the first sentence; code in a sub-line.** Tool names, function names, file paths, and migration numbers belong in an italic `*Technical:*` sub-line under the user-facing one. Skip the sub-line entirely if there is no useful debugging breadcrumb to leave.

**Numbers > adjectives.** "~30% fewer tokens" beats "much faster". "Dropped from $1.42 to $0.45" beats "significantly cheaper". If you don't have a number, say what surface the user sees changed (e.g. "the Insights → Cost page" rather than "metrics").

**No internal jargon in the user-facing sentence.** Avoid "legacy device path", "Wave 1", "PR-B", `ISS-NNN`, "the L2 dispatcher gate". These are fine inside `*Technical:*`. If a feature exists *because of* a removed system, name the user-visible thing it replaces, not the old system's internal name.

**One headline per release.** The first line under `## [X.Y.Z]` is 1–2 sentences in plain language summarising why a user would update. Lead with the user benefit, ideally with one concrete number.

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

Two-pass rule of thumb: a non-developer reading only the bold-text first sentence of every bullet should walk away knowing what the release does for them. A developer reading the *Technical:* lines should know where to start debugging if the change misbehaves.

## Testing a release without publishing

Push a pre-release tag — the workflow runs, but `prerelease: true` is set on the GitHub Release so it doesn't compete with the latest stable for `/download`'s "latest" lookup:

```bash
git tag v0.1.16-rc.1
git push origin v0.1.16-rc.1
```

Re-tag with the stable name once the artifacts look right.

## Rollback / emergency unpublish

```bash
gh release delete vX.Y.Z --repo SidCorp-co/forge --cleanup-tag
```

`--cleanup-tag` removes the git tag too. Forks of installed users on this version stay on it (no auto-downgrade); the next valid release published as Latest takes over the updater channel.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| All 4 build jobs die at "Setup pnpm" with *Multiple versions of pnpm specified* | `pnpm/action-setup` `version:` field set + `packageManager` in `package.json` | Drop the `version:` from the workflow; let `packageManager` win. |
| Lockfile-related cache miss on every run | `cache-dependency-path` points at a non-existent path | Should be `pnpm-lock.yaml` (root); `packages/dev/pnpm-lock.yaml` doesn't exist (workspace) |
| macOS build succeeds but `.dmg` rejected by Gatekeeper | Notarization not stapled | Confirm all six `APPLE_*` secrets set; check `notarytool` output in logs |
| `/download` page falls back to "Build from source" after a successful release | Release still Draft because publish job didn't run | Inspect the `build` matrix — every job must succeed |
| Updater can't fetch `latest.json` | `tauri-action` ran without `includeUpdaterJson: true` or signing key missing | Verify the JSON exists in release assets and matches the pubkey in `tauri.conf.json` |
