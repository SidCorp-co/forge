# 0001 — A release's version is a counter, and MAJOR is a product era

**Status:** accepted · **Date:** 2026-09-27 · **Supersedes:** none

## Context

A release used to be an event with a timestamp and no identity. Nothing afterwards could name which
release carried a given change; the only way to answer "what shipped in that one" was to
reconstruct it from a commit range, which is derivation after the fact.

Semantic versioning does not transfer here. Forge's product version is not a compatibility signal
for a library's consumers, so "breaking change" is not the axis that matters. "Which release shipped
this" is.

Calendar versioning was considered and rejected. This project ships many times a day, so a
`YYYY.MM.N` counter reaches the hundreds within a month and the date prefix stops telling a reader
which day — it loses the one benefit it brings. It would also duplicate `release_released_at`, a
column already stored beside the version.

## Decision

The version is three integers, and the middle one is a plain counter.

- **MINOR increments once per release.** This is the release number.
- **PATCH is reserved for a re-cut** of a release that failed, and is otherwise `0`.
- **MAJOR is a product era.** No release moves it: `nextReleaseVersion` keeps `major` unchanged on
  every branch it takes. It moves only by a deliberate human decision recorded in a later ADR.
  `0` is the current era.
- **A failed release burns its number.** A returned number would mean two different artefacts had
  worn one version, which breaks identity under exactly the conditions where it must hold. The cost
  is a gap in the sequence and nothing else.
- **The number is allocated, never chosen.** `packages/core/src/release-batch/version-store.ts` is
  its only writer, serialising allocation per project on an advisory lock, with a partial unique
  index and a shape check behind it.
- **A pull request does not bump anything.** The release allocates the number; a contributor's
  change does not know which release will carry it.

## Consequences

- Nine digits per component, so the counter does not run out at any shipping rate this project will
  reach.
- `MAJOR` being defined as an era rather than left unstated closes the one gap that would otherwise
  be filled by whoever read the number next.
- The date a release shipped is read from `release_released_at`, never decoded from the version.
- `runner-v*` is a separate scheme on its own clock and is untouched by this.
- **Open, and not decided here:** the runner and the `forge` CLI both consume core's HTTP API, so
  core does have downstream consumers even though it is not a library. Nothing currently signals
  compatibility between them. That is an API-version question, a separate namespace from this
  product version, and it wants its own ADR.
