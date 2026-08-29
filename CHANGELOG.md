# Changelog

> **The entries before 2026-08-28 are missing, not absent.** All 1,034 lines of this file were
> removed by an undeclared deletion inside a docs-pointer commit, and no gate objected. ISS-872
> records the loss; ISS-880 owns restoring the record and making it unlosable. Do not read the short
> list below as the project's release history.

## [Unreleased]

### Added

- `docs/VISION.md` and every proposal now say what adopting them costs the reader, and a gate keeps
  it that way. The constitution had a Boundaries section — what Forge will not become — and nothing
  pricing what choosing Forge takes from a team that chooses it, while the repo's own rule reads "a
  trade-off is priced or it is not taken". `check-honest-costs` refuses an absent section, one that
  prices nothing, and a `TBD` where the price goes; it cannot judge whether a stated price is honest,
  and says so. (ISS-882)

- Attention lists agent-filed `draft` issues that no human has looked at yet. `draft` is inert by
  design — the dispatcher never picks it up and nothing notifies on a draft create — so a proposal
  an agent filed used to be reachable from no surface in the product: measured 2026-08-30, 428 of
  them across 16 projects, all addressed to the account that paired the runner rather than to anyone
  who signs in. They now reach the project's admins, ordered by priority, capped at 20 rows with the
  real total shown; one human comment clears a row for good. (ISS-881)
