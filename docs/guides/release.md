# Release process

How the runner binary and the cloud deploy get versioned and shipped.

## Versioning

Forge ships **two independently-versioned artifacts**. They are NOT one shared
monorepo number — each has its own cadence, tag, and version files. A change to
one never bumps the other.

| Domain | What | How it ships | Tag | Version files (the domain owns these) |
|---|---|---|---|---|
| **runner** | headless CLI daemon (`packages/runner`) | `runner-release.yml` builds binaries; install.sh + auto-update channel | `runner-vX.Y.Z` | `packages/runner/Cargo.toml` (`[workspace.package].version`) |
| **cloud** | core + web-v2 (forge-beta) | continuous deploy from `main` via Coolify | *(none — commit-identified)* | `package.json` (root), `packages/core`, `packages/contracts`, `packages/observability`, `packages/web-v2` `version` |

- **runner** is a tag-driven release (CI builds an artifact).
- **cloud** has no build artifact — it's identified by `SOURCE_COMMIT`, deployed
  on every push to `main`. Its `version` is **display-only** (`forge_version`),
  bumped independently when you want to mark a notable cloud release (edit the 5
  files together; an optional `web-vX.Y.Z` tag may mark the commit — no CI).
- The two are independent: runner `0.6.x` and cloud `0.3.x` legitimately coexist.

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
- **runner** — a core⇄runner wire-protocol or auth change incompatible with an
  older core, or a CLI / `config.toml` change that requires manual user action.
- **cloud** — a `packages/contracts` REST/WS change that breaks an existing
  client (runner or web) it must serve.

### Cutting each release

- **runner:** bump `packages/runner/Cargo.toml` `[workspace.package].version`
  (the runner's `agentVersion` = `CARGO_PKG_VERSION`, which drives auto-update),
  `cargo build` to refresh `Cargo.lock`, commit, then `git tag runner-vX.Y.Z &&
  git push origin runner-vX.Y.Z` → `runner-release.yml`.
- **cloud:** deployed by commit; bump the 5 cloud `version` fields together only
  to mark a notable release (display-only).

Tags must match their pattern exactly (`runner-v*`).

## CHANGELOG

There is **one** `CHANGELOG.md`. Format is a headline line plus a flat bullet
list under each version:

```markdown
## [0.1.16] - 2026-04-30

Short headline — why a user would update.

- Fixed a thing users saw.
- Added a thing users can now do.
```

Runner releases note runner-facing changes in the `runner-vX.Y.Z` GitHub Release
body; cloud changes live in commit/PR history.

### Writing changelog entries — style guide

The CHANGELOG is the **end-user release note**. Optimise it for a person who
never opened the repo and is scanning to decide whether to update. **Keep it flat
and terse, like the Claude Code CLI changelog.**

- **One line per change. No `*Technical:*` sub-line, no bold, no sub-bullets.** The technical detail (file paths, functions, migration numbers, root cause, `ISS-NNN`, merge SHA) lives in the **commit body and the PR** — that's the developer's trail, and duplicating it here is what made the changelog a wall of text. The changelog never repeats it.
- **Lead with the user-visible outcome, in plain language.** Start with a verb where natural (`Fixed…`, `Added…`, or just describe the new behaviour). Past or present tense, ≤ ~120 chars.
  - ✅ `Fixed agent chat failing to send when a runner was online`
  - ✅ `Pipeline uses ~30% fewer tokens per issue`
  - ❌ `buildPipelinePreamble now ships PIPELINE_RULES + TOOL_REFERENCE for cache hits`
- **One concept per bullet.** Two "and"s → split into two bullets.
- **Numbers > adjectives.** "~30% fewer tokens" beats "much faster"; "$1.42 → $0.45" beats "cheaper". No number → name the surface the user sees (e.g. "the Cost page", not "metrics").
- **No internal jargon.** No "legacy device path", "Wave 1", "PR-B", `ISS-NNN`, "L2 dispatcher gate". Name the user-visible thing, not the internal system it replaced.
- **Flat — no `### Added/Fixed` sections.** A single scannable list under the version. (Optionally prefix a bullet with an area, Claude-Code-style: `Runners: …`, `Chat: …` — only when it aids scanning.)
- **One headline per release.** The line right under `## [X.Y.Z]` is 1–2 plain sentences on why a user would update — ideally with one concrete number.

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

Where the technical detail goes: the commit that lands the change. Its body
carries the root cause, files, migration numbers — so `git log` / the PR is the
developer trail, and the CHANGELOG stays the user's.
