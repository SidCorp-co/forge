# Changelog

> **The entries before 2026-08-28 are missing, not absent.** All 1,034 lines of this file were
> removed by an undeclared deletion inside a docs-pointer commit, and no gate objected. ISS-872
> records the loss; ISS-880 owns restoring the record and making it unlosable. Do not read the short
> list below as the project's release history.

## [Unreleased]

### Added

- A plan now records the branches that were weighed and dropped, not only the one that was taken.
  Forge keeps the issue rather than the conversation, so a rejected branch that is not in the plan is
  gone — and a plan without it reads exactly like one where nothing else was ever considered. Both
  plan-writing skills (the autonomous driver and the staged planner) ask for a `Rejected
  alternatives` section naming each branch and the fact that killed it, say that a forced choice is
  written as forced, and say that an empty heading is worse than none. What is checked is that the
  shipped bodies still ask; whether a given plan's rejected branches are real is prose no test can
  read. (ISS-883)

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

### Fixed

- `noProgressRounds` now reaches the mode the pipeline actually runs in. The knob had two readers and
  only one worked: the prompt printed it to every agent, while the alarm compared it to an issue's
  total reopen count — a number that moves only on a `reopen` transition, which autonomous mode never
  performs, because the driver holds the issue in progress from claim to close and the review loop is
  a phase re-entry. Measured 2026-08-30: of 19 runs that went five or more coding rounds inside ONE
  autonomous run, 18 had a reopen count of zero, and the one exception was alarming on reopens from
  its earlier staged life, days before the churn nobody was told about. A second pass counts the
  thing that does move — consecutive review rejections in one running run, with no approval in
  between — and notifies when it reaches the same number. It counts rejections the reviewer wrote,
  not the agent's own account of its progress, so an agent cannot decide whether it is churning; the
  agent's `churn` ledger stays as the human's reading material and is named as such. Rounds that each
  fix a different blocker still do not alarm, and one approval resets the count. Nothing is capped,
  parked or blocked — there is still no limit on how many rounds an issue may take. (ISS-878)
