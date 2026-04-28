# Release process

> **Audience:** maintainers cutting an official release. End users building from source do not need to follow this — they can run `pnpm tauri build` directly.

How a new version of Forge Beta (the Tauri desktop app) gets built, signed, published, and surfaced on `/download`.

## TL;DR

```bash
# 1. Bump versions
#    packages/dev/package.json          version
#    packages/dev/src-tauri/Cargo.toml  package.version
#    packages/dev/src-tauri/tauri.conf.json  version (if explicit)

# 2. Add a CHANGELOG.md entry under ## [X.Y.Z] - YYYY-MM-DD

# 3. Tag + push
git tag vX.Y.Z
git push origin vX.Y.Z
```

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

The repo uses pre-`1.0` semver per [ADR](../decisions/) precedent — `v0.X.Y` while in alpha. Tags must match `v*.*.*` exactly (workflow trigger pattern). Pre-release suffix (`v0.1.16-rc.1`) marks GitHub Release as pre-release automatically.

Bump these in lockstep:

| File | Field |
|---|---|
| `packages/dev/package.json` | `version` |
| `packages/dev/src-tauri/Cargo.toml` | `package.version` |
| `packages/dev/src-tauri/tauri.conf.json` | `version` (if not `auto`) |

Mismatches cause the in-app updater to behave oddly — keep them aligned.

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

## Testing a release without publishing

Push a pre-release tag — the workflow runs, but `prerelease: true` is set on the GitHub Release so it doesn't compete with the latest stable for `/download`'s "latest" lookup:

```bash
git tag v0.1.16-rc.1
git push origin v0.1.16-rc.1
```

Re-tag with the stable name once the artifacts look right.

## Rollback / emergency unpublish

```bash
gh release delete vX.Y.Z --repo junixlabs/jarvis-agents --cleanup-tag
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
