/**
 * ISS-1315 r5 — a statement sent on a transaction whose connection the server ended is refused
 * with the error the transaction was rejected with. postgres 3.4.9 wrote it from an immediate to a
 * null socket, which exited the process, or ran it in autocommit on the session the pool opened
 * next; the root `patches/postgres@3.4.9.patch` is what this file pins. Each case runs in a child
 * process, because the defect is the process exiting.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

const CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  '../helpers/server-ended-transaction.mjs',
);

interface ChildRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCase(url: string, kind: string): Promise<ChildRun> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHILD, url, kind], { timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        stderr,
      });
    });
  });
}

/** The case's printed outcome; a child that died fails naming its exit and what it printed. */
async function outcome(url: string, kind: string): Promise<Record<string, unknown>> {
  const run = await runCase(url, kind);
  expect(
    run.exitCode,
    `the "${kind}" case's process exited ${run.exitCode}; stderr:\n${run.stderr}`,
  ).toBe(0);
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

describe('a transaction whose connection the server ended', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  it('refuses the next statement with the transaction’s own error when the backend is terminated between two statements', async () => {
    expect(await outcome(harness.url, 'terminated')).toEqual({
      kind: 'terminated',
      transaction: 'CONNECTION_CLOSED',
      next: 'CONNECTION_CLOSED',
      sameError: true,
    });
  });

  it('refuses the next statement with the transaction’s own error once idle_in_transaction_session_timeout ends the session', async () => {
    expect(await outcome(harness.url, 'idleTimeout')).toEqual({
      kind: 'idleTimeout',
      transaction: 'CONNECTION_CLOSED',
      next: 'CONNECTION_CLOSED',
      sameError: true,
    });
  });

  it('sends no rollback down a session cut while a statement was in flight, and the pool serves the next statement', async () => {
    expect(await outcome(harness.url, 'inFlight')).toEqual({
      kind: 'inFlight',
      transaction: 'CONNECTION_CLOSED',
      after: 'ran',
    });
  });

  it('runs none of the transaction’s statements on the session the pool reconnects for a queued statement', async () => {
    expect(await outcome(harness.url, 'queuedReconnect')).toEqual({
      kind: 'queuedReconnect',
      transaction: 'CONNECTION_CLOSED',
      next: 'CONNECTION_CLOSED',
      sameError: true,
    });
  });

  it('refuses a statement sent on a reserved connection with no socket as CONNECTION_CLOSED', async () => {
    expect(await outcome(harness.url, 'reserved')).toEqual({
      kind: 'reserved',
      first: 'CONNECTION_CLOSED',
      second: 'CONNECTION_CLOSED',
    });
  });

  it('serves every later statement from the pool once a reserved connection the server ended is released', async () => {
    expect(await outcome(harness.url, 'reservedReleased')).toEqual({
      kind: 'reservedReleased',
      refused: [],
    });
  });

  it('runs none of a reserved connection’s statements on the session the pool reconnects it for', async () => {
    expect(await outcome(harness.url, 'reservedReconnected')).toEqual({
      kind: 'reservedReconnected',
      next: 'CONNECTION_CLOSED',
      poolMoved: true,
      after: 'ran',
    });
  });

  it('leaves a second reservation holding a reconnected connection when the first, ended, is released', async () => {
    expect(await outcome(harness.url, 'reservedReleasedAfterReuse')).toEqual({
      kind: 'reservedReleasedAfterReuse',
      second: 'ran',
      order: ['second released', 'pool'],
    });
  });

  it('hands a reservation waiting for the pool’s only connection the one reconnected after the server ends it', async () => {
    expect(await outcome(harness.url, 'reservedWaiting')).toEqual({
      kind: 'reservedWaiting',
      second: 'ran',
    });
  });

  it('runs the first statement on a reconnected session rather than rejecting it with the ended session’s FATAL', async () => {
    expect(await outcome(harness.url, 'staleError')).toEqual({
      kind: 'staleError',
      inFlight: 'CONNECTION_CLOSED',
      next: 'ran',
    });
  });
});
