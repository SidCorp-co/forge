# A request-keyed outbound delivery cannot be retried by the queue that owns it

**Status: OPEN (2026-09-17). Found by the whole-set review of ISS-1085 slice 2, measured against
`main` at `b3131c46e`, and left here rather than fixed because the fix is a decision about the
delivery log's idempotency semantics and the deploy confirm-gate hangs off them.**

## What is true today

`integration_deliveries` carries a partial unique index — `db/schema.ts`,
`integration_deliveries_binding_request_id_uq` on `(binding_id, request_id) WHERE request_id IS NOT
NULL` — whose comment calls it an idempotency key: *"a dispatch keyed by (binding, requestId) is
deduped at the DB level"*.

`deliveries.ts:recordDelivery` inserts unconditionally. There is no `onConflict` clause and no
lookup of an existing row, so a second insert under the same key does not dedupe: it raises, and the
error surfaces wherever the caller happened to be.

`queue.ts:enqueueOutboundDispatch` sends every outbound dispatch with `retryLimit: 5` and
`retryBackoff: true`, and `runOutboundDispatch` **rethrows** on failure by design — the `cm:guard` in
`queue.test.ts` says why: pg-boss's retry policy is the only thing that re-runs the job.

Those three facts do not compose. pg-boss re-runs the job with the same payload, the payload carries
the same `requestId`, the adapter records a delivery under the same key, and the insert dies on the
index **before the provider is contacted at all**.

## What it costs, on the path that has carried it longest

This is not ISS-1085's. Coolify's deploy path has had this shape since the index existed, and it is
where it costs most:

- `release-coolify.ts:163` mints one `requestId` per attempt and puts it **in the job payload**, so
  it is fixed for the life of that job rather than per execution.
- `coolify/adapter.ts:187` derives `${input.requestId}:${target.id}` — deterministic for the same
  job and target.
- So a Coolify deploy that fails transiently on its first attempt — a 502, a reset connection —
  burns its remaining four backoff attempts on a Postgres unique violation and never calls Coolify
  again. The operator sees one failed delivery and a retry policy that did nothing.

A crash between the insert and the settle leaves the same wreckage in the other direction: a
`pending` row that no later attempt can reach, because every later attempt collides with it.

ISS-1085's Sentry dispatch inherits the shape rather than introducing it, and inherits it with less
at stake: slice 2 has no production caller, so the only way to queue a Sentry delivery today is the
delivery log's own Retry button, which mints a fresh `retry_<hex>` each time a person presses it.
The person can press it again. A release cannot.

## Why this is a proposal and not a commit

The fix is one function — an idempotent acquire in `recordDelivery` — and every shape of it is a
decision somebody has to make about what a delivery row MEANS:

1. **Resume the existing row** (`onConflictDoUpdate` back to `pending`, return its id). Correct for
   a replay, and it makes the log show one row per request rather than one per attempt. But it
   overwrites a settled row's `response`, `errorMessage` and `durationMs`, and
   `deploy-confirmations.ts` holds one confirmation per `deliveryId` — a row a hold points at is not
   obviously ours to rewrite.
2. **Return the existing row's recorded result** where it already reached `ok`, and resume only a
   `failed` or `pending` one. Truest to "idempotency key", and the most behaviour to get wrong.
3. **Key the index per attempt instead**, so each execution is its own row. Cheapest, and it gives
   up the dedupe the index's own comment says it is for — the reason `routes.ts` must not pre-record
   a retry.

Whichever is chosen, the proof is a database-backed worker test: first attempt answered HTTP 500,
the same job and `requestId` replayed against a success, assert the provider is contacted a second
time and exactly one delivery ends `ok`, plus the same against an existing `pending` row. That is
`core-integration`, which needs a Postgres this box shares with every other session on it and cannot
drop.

So: a shared path, a live deploy confirm-gate on the other end of it, three defensible shapes, and a
proof that only CI can run. None of that belongs inside a change about a Sentry adapter, and the
choice belongs to whoever owns the delivery log's contract.
