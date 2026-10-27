// One case of a connection the server ends under a statement, run in its own process so a crash
// shows as this process's exit rather than the test runner's. Prints one JSON line on success.
// Usage: node server-ended-transaction.mjs <database url> <case>
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const [, , url, kind] = process.argv;
const admin = postgres(url, { max: 1, onnotice: () => {} });
const out = { kind };
const outcome = (p) =>
  p.then(
    () => 'ran',
    (e) => e,
  );
// drizzle wraps a failed statement in a DrizzleQueryError whose cause is the driver's error.
const driverError = (r) => (r instanceof Error && r.cause instanceof Error ? r.cause : r);
const code = (r) => (r === 'ran' ? r : (driverError(r)?.code ?? String(r)));

async function backendPid(tx) {
  const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  return row.pid;
}

/** The transaction's own rejection and its callback's next statement, read once the callback ends. */
async function transactionAfterItsServerEnds(client, between, next) {
  const db = drizzle(client);
  let calledBack;
  const callbackEnded = new Promise((resolve) => {
    calledBack = resolve;
  });
  const transaction = outcome(
    db.transaction(async (tx) => {
      try {
        await between(tx);
        calledBack(await outcome(next(tx)));
      } catch (error) {
        calledBack(error);
        throw error;
      }
    }),
  );
  const [rejected, nextStatement] = await Promise.all([transaction, callbackEnded]);
  out.transaction = code(rejected);
  out.next = code(nextStatement);
  out.sameError = driverError(nextStatement) === rejected;
}

const cases = {
  async terminated() {
    const client = postgres(url, { max: 1 });
    await transactionAfterItsServerEnds(
      client,
      async (tx) => {
        await admin`SELECT pg_terminate_backend(${await backendPid(tx)})`;
        await sleep(300);
      },
      (tx) => tx.execute(sql`SELECT 2`),
    );
  },

  async idleTimeout() {
    // The setting core's client.ts:buildDb gives every connection, shortened to fit a test.
    const client = postgres(url, {
      max: 1,
      connection: { idle_in_transaction_session_timeout: 200 },
    });
    await transactionAfterItsServerEnds(
      client,
      async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await sleep(700);
      },
      (tx) => tx.execute(sql`SELECT 2`),
    );
  },

  async inFlight() {
    // The statement in flight is cut; the callback rethrows, and the rollback that follows has no
    // session to go to.
    const client = postgres(url, { max: 1 });
    const db = drizzle(client);
    const transaction = await outcome(
      db.transaction(async (tx) => {
        const pid = await backendPid(tx);
        setTimeout(() => admin`SELECT pg_terminate_backend(${pid})`.then(() => {}), 200);
        await tx.execute(sql`SELECT pg_sleep(5)`);
      }),
    );
    await sleep(500);
    out.transaction = code(transaction);
    out.after = code(await outcome(db.execute(sql`SELECT 1`)));
  },

  async queuedReconnect() {
    // A pool statement queued behind the transaction makes the pool reconnect the very connection
    // the transaction held; the transaction's next statement must not run on that new session.
    const client = postgres(url, { max: 1 });
    let queued;
    await transactionAfterItsServerEnds(
      client,
      async (tx) => {
        const pid = await backendPid(tx);
        queued = client`SELECT 1`.then(() => 'ran');
        await admin`SELECT pg_terminate_backend(${pid})`;
        await queued;
      },
      (tx) => backendPid(tx),
    );
  },

  async reserved() {
    const client = postgres(url, { max: 2 });
    const reserved = await client.reserve();
    const [{ pid }] = await reserved`SELECT pg_backend_pid() AS pid`;
    await admin`SELECT pg_terminate_backend(${pid})`;
    await sleep(300);
    out.first = code(await outcome(reserved`SELECT 1`));
    out.second = code(await outcome(reserved`SELECT 1`));
  },

  async reservedReleased() {
    // A reserved connection the server ended, handed back: the pool serves every later statement.
    const client = postgres(url, { max: 2 });
    const reserved = await client.reserve();
    const [{ pid }] = await reserved`SELECT pg_backend_pid() AS pid`;
    await admin`SELECT pg_terminate_backend(${pid})`;
    await sleep(300);
    reserved.release();
    const after = await Promise.all(Array.from({ length: 20 }, () => outcome(client`SELECT 1`)));
    out.refused = after.filter((r) => r !== 'ran').map(code);
  },

  async reservedReconnected() {
    const client = postgres(url, { max: 1 });
    const reserved = await client.reserve();
    const [{ pid }] = await reserved`SELECT pg_backend_pid() AS pid`;
    const queued = client`SELECT pg_backend_pid() AS pid`;
    await admin`SELECT pg_terminate_backend(${pid})`;
    const [{ pid: poolPid }] = await queued;
    out.next = code(await outcome(reserved`SELECT pg_backend_pid() AS pid`));
    out.poolMoved = poolPid !== pid;
    reserved.release();
    out.after = code(await outcome(client`SELECT 1`));
  },

  async reservedReleasedAfterReuse() {
    // The pool reconnects the first reservation's connection for a second one before the first
    // lets go; the first's release must leave the second holding it.
    const client = postgres(url, { max: 1 });
    const first = await client.reserve();
    const [{ pid }] = await first`SELECT pg_backend_pid() AS pid`;
    await admin`SELECT pg_terminate_backend(${pid})`;
    await sleep(300);
    const second = await client.reserve();
    first.release();
    const order = [];
    const pool = client`SELECT 1`.then(() => order.push('pool'));
    out.second = code(await outcome(second`SELECT 1`));
    await sleep(300);
    order.push('second released');
    second.release();
    await Promise.race([pool, sleep(5000)]);
    out.order = order;
  },

  async reservedWaiting() {
    // A reservation waiting for the pool's only connection when the server ends it.
    const client = postgres(url, { max: 1 });
    const first = await client.reserve();
    const [{ pid }] = await first`SELECT pg_backend_pid() AS pid`;
    const second = client.reserve().then((held) => held`SELECT 1`);
    await admin`SELECT pg_terminate_backend(${pid})`;
    out.second = code(
      await Promise.race([outcome(second), sleep(5000).then(() => 'never handed one')]),
    );
  },

  async staleError() {
    const client = postgres(url, { max: 1 });
    const [{ pid }] = await client`SELECT pg_backend_pid() AS pid`;
    setTimeout(() => admin`SELECT pg_terminate_backend(${pid})`.then(() => {}), 200);
    out.inFlight = code(await outcome(client`SELECT pg_sleep(5)`));
    await sleep(300);
    out.next = code(await outcome(client`SELECT 1`));
  },
};

const run = cases[kind];
if (!run) {
  console.error(
    `server-ended-transaction: no case named "${kind}"; one of ${Object.keys(cases).join(', ')}`,
  );
  process.exit(2);
}
await run();
// Long enough for a write the ended session still owed to reach its immediate.
await sleep(300);
console.log(JSON.stringify(out));
await admin.end({ timeout: 1 });
process.exit(0);
