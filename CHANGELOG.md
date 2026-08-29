# Changelog

> **The entries before 2026-08-28 are missing, not absent.** All 1,034 lines of this file were
> removed by an undeclared deletion inside a docs-pointer commit, and no gate objected. ISS-872
> records the loss; ISS-880 owns restoring the record and making it unlosable. Do not read the short
> list below as the project's release history.

## [Unreleased]

### Added

- Attention lists agent-filed `draft` issues that no human has looked at yet. `draft` is inert by
  design — the dispatcher never picks it up and nothing notifies on a draft create — so a proposal
  an agent filed used to be reachable from no surface in the product: measured 2026-08-30, 428 of
  them across 16 projects, all addressed to the account that paired the runner rather than to anyone
  who signs in. They now reach the project's admins, ordered by priority, capped at 20 rows with the
  real total shown; one human comment clears a row for good. (ISS-881)
