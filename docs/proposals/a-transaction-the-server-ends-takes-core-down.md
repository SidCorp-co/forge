# A transaction the server ends takes core down on its next statement

Found while working ISS-1315 r4, whose test teardown was one way to reach it. Left here rather than
fixed, because the fix is a patch to the `postgres` package, which is recorded in `pnpm-lock.yaml`,
and that file was held uncommitted by another tree when this was written.

## What is measured

`postgres` 3.4.9 (the newest published) runs a transaction's statements straight on its reserved
connection (`src/index.js:begin`, the scope's `handler`). When the server ends that connection,
`src/connection.js:closed` sets `socket` to null and rejects the transaction, but the transaction's
own function keeps running, and its next statement goes to `execute`, which checks only
`terminated` — set by a close from the client's side, never by one from the server's. `write`
queues the bytes on `setImmediate(nextWrite)`, and `nextWrite` calls `socket.write` on null:

```
TypeError: Cannot read properties of null (reading 'write')
 ❯ Immediate.nextWrite node_modules/postgres/src/connection.js:255:22
```

It is thrown from an immediate, so nothing in the caller can catch it, and `packages/core/src` has no
`uncaughtException` handler: the process exits.

Reproduced on 2026-10-26 against a `pgvector/pgvector:pg17` instance, outside any test runner:

- a transaction whose backend `pg_terminate_backend` ends between two statements;
- a transaction that stays idle past `idle_in_transaction_session_timeout` and then sends its next
  statement. Core sets that timeout on every connection (`src/db/client.ts:buildDb`,
  `DATABASE_IDLE_IN_TX_TIMEOUT_MS`, 30s by default), so a transaction that waits on anything slow
  inside it for that long is this path in production.

## What would end it

`execute` refusing a statement once `socket` is null, with the `CONNECTION_CLOSED` error the
transaction was already rejected with, carried as a `pnpm patch` of `postgres` until the package
ships the same check, and an integration case that ends a transaction's backend between two
statements and reads the next statement's refusal.
