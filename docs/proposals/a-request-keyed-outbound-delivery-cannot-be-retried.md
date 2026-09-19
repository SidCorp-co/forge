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
`retryBackoff: true`, and `runOutboundDispatch` **rethrows** on failure by design — the invariant in
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

## Honest costs

Priced against the three shapes below, not against the bug they fix.

| Cost | Who pays it |
|---|---|
| Shape 1 or 2 makes a delivery row mutable after it has settled. `deploy-confirmations.ts` holds one confirmation per `deliveryId`, and `deliveries.ts:findDeliveryByRequestId` is how the release path reaches a dispatch it already made — both now read a row whose `status`, `response` and `durationMs` can go backwards under them. Every future reader of the delivery log has to know that a row is the latest attempt rather than an attempt. | whoever reads or joins on a delivery row |
| Shape 1 or 2 loses the per-attempt history the log shows today. An operator looking at a deploy that failed twice and then worked sees one row, not three, and the two failures are gone rather than stacked. That is the same information the delivery log exists to give them. | whoever debugs a flapping integration |
| Shape 3 gives up the dedupe the unique index is named for. `routes.ts`'s retry handler must NOT pre-record a delivery precisely because the index collides; drop the guarantee and that reasoning has to be re-derived, and two senders reusing one `requestId` become two dispatches instead of one. | whoever relies on `(binding, requestId)` as an idempotency key |
| Whichever shape wins, the proof is `core-integration`. That suite needs a Postgres this box shares with every other session on it, so the fix cannot be proved on a developer machine that is not alone — it is a CI-only red until someone stands up a private database for it. | whoever builds the fix |
| Doing nothing has a price too, and it is the one already being paid: every transient failure on a request-keyed outbound job silently spends its five backoff attempts on a Postgres error. Nobody is told, because the job's own error message is about a unique constraint rather than about the provider. | whoever waits on a deploy that quietly stopped retrying |

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
