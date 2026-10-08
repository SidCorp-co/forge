# A value Postgres case-folds passes the query-error seal

Found while judging ISS-1383 (judge j4, at 0aa735e). The seal and every sink look for a bound value
as it was bound (`packages/observability/src/query-params.ts:sealQueryError`, `redactQueryParams`).
Postgres lowercases a value that a `regclass` cast or `date_trunc` unit refuses, so
`'Mixed…'::regclass` answers `relation "mixed…" does not exist`, and that lowercased value stays in
the sealed message and stack.

## What is left

Nothing in `packages/core/src` casts a value a caller sent to `regclass`. Every unit passed to
`lib/time-buckets.ts:utcDateTrunc` is a literal or one of a route's fixed `z.enum` choices. So no
value from outside reaches either text today, and ISS-1383 r5 did not build a case-blind search.

## Honest costs

- A future call site that casts a caller's value to `regclass`, or passes a caller's unit to
  `date_trunc`, would log that value in lowercase, and no test would go red.
- A case-blind search of every bound value would also remove ordinary words that match a value in
  another case.

## What would close it

Before such a call site lands, the seal searches each bound value case-blind inside the texts of
these two refusals only (`relation "…" does not exist`, `unit "…" not recognized`), and a test
against a real Postgres drives a mixed-case value through each one.
