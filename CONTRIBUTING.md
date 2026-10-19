# Contributing to Forge

Thanks for your interest. The project is in alpha — every piece of feedback is valuable.

This file is the front door: the order a change goes in, and where each rule it meets is written.
A rule another file owns appears here as a link to that file, never as a second copy, and the owner
is right if the two ever disagree. The two this file owns itself are steps 1 and 3 below.

## Where the rules live

| File | Owns |
|---|---|
| [`docs/VISION.md`](docs/VISION.md) | what Forge is and is not — intent, and the final word on intent |
| [`CLAUDE.md`](CLAUDE.md) | how work is done here: the seven gate axes, the invariants, the ownership line |
| [`scripts/README.md`](scripts/README.md) | every gate, what it refuses, and what it was born from |
| [`GOVERNANCE.md`](GOVERNANCE.md) | who reviews, who merges, and what an agent may decide alone |
| [`docs/adr/`](docs/adr/) | decisions that shaped the above, and why |

## Getting a change in

1. **Open an issue first** unless the change is trivial. Significant designs are argued in
   [`docs/proposals/destination/`](docs/proposals/destination/) before they are built.
2. **Branch from the default branch**, under a name `scripts/check-branch-name.sh` accepts — its
   schemes are in [`scripts/README.md`](scripts/README.md#check-branch-namesh). Renaming a branch
   after a pull request is open orphans the pull request.
3. **Write [Conventional Commits](https://www.conventionalcommits.org/)** — `fix(core): …`,
   `feat(gates): …`, `docs(npmrc): …`. This is already the convention in the history; nothing
   enforces it yet, so it is on you.
4. **Before you push, run what [`CLAUDE.md`](CLAUDE.md#commands) *Commands* names**, and read there
   what each command proves.
5. **Open a pull request** and fill [the template](.github/PULL_REQUEST_TEMPLATE.md). The
   declarations it asks for decide how your change is handled, so answer them honestly.

## What gets a change merged

Which check is required, where it runs, and what a skipped job means:
[`CLAUDE.md`](CLAUDE.md#commands) *Commands*. What a green check is evidence for:
[`CLAUDE.md`](CLAUDE.md#green-is-a-claim-about-one-proposition) *Green is a claim about one
proposition*. Each gate behind it: [`scripts/README.md`](scripts/README.md). Who merges, and that it
is not you: [`GOVERNANCE.md`](GOVERNANCE.md#merge-authority).

## The rule that fails silently

**Migration order** breaks without an error: a migration taken out of order is skipped, and
nothing says so. The rule and the number to take are
[`CLAUDE.md`](CLAUDE.md#invariants) *Invariants*; why the checker measures every open branch rather
than yours is `scripts/check-migration-order.mjs` in [`scripts/README.md`](scripts/README.md).

A changelog entry over its word budget is not silent: `check-release-record` refuses it in CI and in
`pnpm verify`, printing the entry and the ceiling it applied, and exits non-zero. Its rules are
`scripts/check-release-record.mjs` in [`scripts/README.md`](scripts/README.md).

## Reporting a security vulnerability

**Never a public issue.** Use
[private reporting](https://github.com/SidCorp-co/forge/security/advisories/new). See
[`SECURITY.md`](SECURITY.md).
