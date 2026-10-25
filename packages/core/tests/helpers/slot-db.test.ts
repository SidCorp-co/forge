import { describe, expect, it } from 'vitest';
import { setupTestDatabase } from './db.js';
import {
  bornAt,
  mintedBy,
  mintRunToken,
  OWN_PREFIX,
  ownDbName,
  slotRefusal,
  WORKER_PREFIX,
  workerDbName,
} from './scratch-db.js';

const TOKEN = mintRunToken();

describe('slot and own database names', () => {
  it('answers the same slot database every time the same slot asks, within one run', () => {
    expect(workerDbName('3', TOKEN)).toBe(workerDbName('3', TOKEN));
  });

  it('answers a different slot database for another slot, or another run', () => {
    expect(workerDbName('3', TOKEN)).not.toBe(workerDbName('4', TOKEN));
    expect(workerDbName('3', TOKEN)).not.toBe(workerDbName('3', mintRunToken()));
  });

  it('carries the slot and this run\u2019s token, so a sweep can tell it from another run\u2019s', () => {
    expect(workerDbName('3', TOKEN)).toBe(`${WORKER_PREFIX}3_${TOKEN}`);
    expect(mintedBy(workerDbName('3', TOKEN), TOKEN)).toBe(true);
  });

  it('refuses a run with no template rather than minting an unsweepable slot database', () => {
    expect(() => workerDbName('3', null)).toThrow(/TEST_PG_RUN_TOKEN/);
  });

  it('refuses a slot vitest would never give', () => {
    for (const slot of ['0', '', 'x', '-1', '12345']) {
      expect(() => workerDbName(slot, TOKEN)).toThrow(/VITEST_POOL_ID/);
    }
  });

  it('dates a slot database by the run that minted it', () => {
    const before = Date.now();
    const born = bornAt(workerDbName('2', mintRunToken()));
    expect(born as number).toBeGreaterThanOrEqual(before - 1000);
    expect(born as number).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('mints a different own database for every call, under its own prefix', () => {
    const a = ownDbName(TOKEN);
    expect(a).not.toBe(ownDbName(TOKEN));
    expect(a.startsWith(`${OWN_PREFIX}${TOKEN}_`)).toBe(true);
    expect(bornAt(a)).not.toBeNull();
    expect(mintedBy(a, TOKEN)).toBe(true);
    expect(() => ownDbName(null)).toThrow(/TEST_PG_RUN_TOKEN/);
  });
});

describe('slotRefusal', () => {
  const owner = { pid: 4000, ppid: 1 };
  const worker = { pid: 4100, ppid: 4000 };
  const env = (over: Record<string, string | undefined> = {}) => ({
    VITEST_POOL_ID: '2',
    TEST_PG_RUN_TOKEN: TOKEN,
    TEST_PG_RUN_OWNER: '4000',
    ...over,
  });

  it('hands a slot to a worker the minting run forked', () => {
    expect(slotRefusal(env(), worker)).toBeNull();
  });

  it('hands a slot to a thread of the minting process itself', () => {
    expect(slotRefusal(env(), owner)).toBeNull();
  });

  it('refuses a process with no worker slot, naming the variable', () => {
    expect(slotRefusal(env({ VITEST_POOL_ID: undefined }), worker)).toMatch(
      /VITEST_POOL_ID is unset/,
    );
    expect(slotRefusal(env({ VITEST_POOL_ID: '0' }), worker)).toMatch(/VITEST_POOL_ID is "0"/);
  });

  it('refuses a vitest launched apart that inherited the token, naming the process that owns it', () => {
    const apart = { pid: 5100, ppid: 5000 };
    const said = slotRefusal(env(), apart);
    expect(said).toContain(`TEST_PG_RUN_TOKEN=${TOKEN} was minted by process 4000`);
    expect(said).toContain('pid 5100, parent 5000');
  });

  it('refuses a token no global setup claimed', () => {
    expect(slotRefusal(env({ TEST_PG_RUN_OWNER: undefined }), worker)).toMatch(/\(unnamed\)/);
  });
});

describe('setupTestDatabase({ own })', () => {
  it('refuses a declaration that gives no reason, before it reaches any database', async () => {
    for (const own of ['', '   ']) {
      await expect(setupTestDatabase({ own })).rejects.toThrow(
        `setupTestDatabase({ own }) takes the reason this file cannot share its worker slot's database`,
      );
    }
  });
});
