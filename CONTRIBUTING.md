# Contributing to Forge

Thanks for your interest. The project is in alpha — every piece of feedback is valuable.

This file is the front door. It says how to get a change in and what gets it merged. It does not
restate the rules; each one below names the file that owns it, and that file is right if the two
ever disagree.

## Where the rules live

| File | Owns |
|---|---|
| [`docs/VISION.md`](docs/VISION.md) | what Forge is and is not — intent, and the final word on intent |
| [`CLAUDE.md`](CLAUDE.md) | how work is done here: the six gate axes, the invariants, the ownership line |
| [`scripts/README.md`](scripts/README.md) | every gate, what it refuses, and what it was born from |
| [`GOVERNANCE.md`](GOVERNANCE.md) | who reviews, who merges, and what an agent may decide alone |
| [`docs/adr/`](docs/adr/) | decisions that shaped the above, and why |

## Getting a change in

1. **Open an issue first** unless the change is trivial. Significant designs are argued in
   [`docs/proposals/destination/`](docs/proposals/destination/) before they are built.
2. **Branch from the default branch**, named `ISS-<number>-<slug>`. Renaming a branch after a pull
   request is open orphans the pull request.
3. **Write [Conventional Commits](https://www.conventionalcommits.org/)** — `fix(core): …`,
   `feat(gates): …`, `docs(npmrc): …`. This is already the convention in the history; nothing
   enforces it yet, so it is on you.
4. **Run `pnpm verify` before you push.** It declares the suites and the build rather than running
   them all; `pnpm test:changed` is the inner loop and selects by import graph, which is why it is
   a loop and not a proof.
5. **Open a pull request** and fill [the template](.github/PULL_REQUEST_TEMPLATE.md). The
   declarations it asks for decide how your change is handled, so answer them honestly.

## What gets a change merged

**`ci-passed` is the one required check, and CI is the gate — not your laptop.** A green laptop and
a red `ci-passed` means the change does not land. Branch protection does not require your branch to
be current with the base (`strict: false`, read from the `main` protection on 2026-10-06), so
`ci-passed` judges your branch as it stands, not merged onto the latest base: merge the base in
before you push when it has moved.

**Green covers the jobs that ran.** A skipped job passes `ci-passed`; the `changes` filter decides
which run. Read which ran, not the aggregate alone — a suite the filter should have selected and
did not is a defect, not a pass.

**Who merges is not you.** See [`GOVERNANCE.md`](GOVERNANCE.md).

## Two things that fail silently, so they are stated here

**Migration order.** A migration's `when` in `packages/core/drizzle/migrations/meta/_journal.json`
must exceed every `created_at` already in the target database. Drizzle reads the single highest
once and **skips lower entries silently, forever** — the container then starts and serves new code
against an old schema. `node scripts/check-migration-order.mjs` prints the number to take, and its
`Next free:` line is the only place to read one from. The subject is every open branch, not only
yours: branches each deriving their number from one base all land on the same one, and whichever
merges first silently kills the rest.

**Changelog entries are capped at 40 words** by `check-release-record`. Entries of 59, 156 and 235
words have each been refused.

## Reporting a security vulnerability

**Never a public issue.** Use
[private reporting](https://github.com/SidCorp-co/forge/security/advisories/new). See
[`SECURITY.md`](SECURITY.md).
