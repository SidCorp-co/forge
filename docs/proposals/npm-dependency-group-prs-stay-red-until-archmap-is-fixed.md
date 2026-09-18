# Every npm dependency-group PR stays red until archmap is fixed and re-vendored

**Status:** Open residual, measured, fix filed in another repository. Found and left standing by
ISS-1098, which shipped the diagnosis and not the cure.

## The operational cost, stated first

**No npm dependency-group PR can reach a green `ci-passed` in this repository today.** `archmap`
sits in `ci-passed`'s `needs`, and it cannot run once the lockfile carries dependency-cruiser
18.3.0 or newer. #509 failed twice at two different base commits; #369, #394, #425 and #448 were
all closed unmerged over the preceding week. #509 and #510 are blocked on an issue in a repository
this one does not gate.

Cargo-only dependabot PRs are unaffected — they do not touch `pnpm-lock.yaml`.

## Why this repository cannot fix it

dependency-cruiser renamed its CLI entry point in 18.3.0, from `bin/dependency-cruise.mjs` to
`bin/dependency-cruiser.mjs`. The vendored `.forge/archmap/src/providers/ts.mjs` walks
`node_modules` for the old filename alone, finds nothing, and the TypeScript provider returns
`ok: false`. With no `go.mod` here the Go provider returns an empty-but-ok graph, so archmap's
`buildScope` never reaches the branch that prints a provider's reason and exits instead with
`scope matched no files (.)` — a sentence about this repository's scope.

Measured 2026-09-18 in a clean worktree at `55ef822d0`, `pnpm install --frozen-lockfile` exit 0:
18.2.0 gives `2894 files · 9805 edges`, exit 0; 18.3.1 gives `scope matched no files (.)`, exit 2,
0.117s; reverting to 18.2.0 by the same route restores the graph.

archmap takes no configuration for where its resolver lives, and the CI job runs the vendored
binary directly. **The source checkout at 0.1.5 — one version newer than the vendored 0.1.4 —
carries the identical line**, so upgrading does not clear it either.

That leaves three routes, and only the first is honest:

1. archmap fixes the resolution and this repository re-vendors the result.
2. `pnpm.patchedDependencies` restoring the old filename — a patch on a third party's package to
   work around our own tool's bug, invisible at the point anyone would look for it.
3. Pinning dependency-cruiser below 18.3.0 — a pin with no end condition, which ISS-1098 forbade
   for that reason.

## What ISS-1098 did ship

The `archmap-resolver` prerequisite in `scripts/lib/prerequisite.mjs`, resolved by `verify.mjs`,
`conformance-audit.mjs` R7 and `scripts/check-archmap-ready.mjs` in the CI job. All four now name
dependency-cruiser and the missing entry point instead of blaming this repository's scope. The
gate still exits 2 and the PR is still red — correctly, because the architecture gate did not run.
**Distinguishable is not green, and nothing here should be read as having restored the class.**

## The condition that ends this

archmap ISS-10 (the hardcoded resolver filename) lands, archmap cuts a release carrying it, and
`archmap install --force` re-vendors that release into `.forge/archmap/` here. archmap ISS-11 (a
provider's failure reported as an empty scope) is what made this cost a week instead of an hour;
it is not on the critical path for the red, and is worth having before the next resolver change.

At that point `^18` in `packages/core/package.json` resolves to a dependency-cruiser archmap can
spawn, and the `archmap-resolver` prerequisite stops firing on its own. Nothing here needs
retracting — the prerequisite is correct at every version and silent at the good ones.

## Honest costs

The price of route 1 — archmap fixes the resolution and this repository re-vendors the result.

| Cost | What it takes |
|---|---|
| The wait is another repository's | archmap ships on its own clock. Nothing here can gate it, prioritise it or set its date, and npm dependency bumps stay parked for however long that is. |
| A re-vendor is a reviewed diff over `.forge/archmap/**` | `archmap install --force` rewrites the whole vendored tree and every `MANIFEST.json` hash with it. It is not a one-line bump, and `scripts/README.md` already warns that a re-vendor can drop this repo's `--ts-config` handling if upstream moved. |
| The gate goes quiet for one run | Between the re-vendor landing and the first green `archmap check`, nobody has measured this repo's graph against the new resolver. The first run after it is the one that must be read, not skimmed. |
| Dependency debt accrues meanwhile | Every npm group PR that cannot land is a security and maintenance update that does not land either. The longer route 1 takes, the larger the batch that eventually merges at once, and the harder it is to attribute a regression in it. |
| Route 2 and route 3, if either is ever taken | A `pnpm.patchedDependencies` patch is invisible at the point anyone would look for it, and a pin carries an end condition somebody has to come back and retire. Both were rejected for ISS-1098 and both would have to be priced again, in the open, before being taken. |
