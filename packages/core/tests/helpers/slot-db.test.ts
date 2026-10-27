import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { reportLingeringConnections, sever } from './slot-db.js';

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

describe('setupTestDatabase in schema mode with no server named', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('points at the README’s test-only Postgres, not the compose dev database', async () => {
    for (const name of ['TEST_DATABASE_URL', 'TEST_PG_ADMIN_URL', 'TEST_PG_TEMPLATE'])
      vi.stubEnv(name, '');
    vi.stubEnv('TEST_DB_MODE', 'schema');
    const refusal = setupTestDatabase().then(
      () => '',
      (err: Error) => err.message,
    );
    expect(await refusal).toContain('packages/core/tests/README.md');
    expect(await refusal).toContain('-c fsync=off');
    expect(await refusal).not.toContain('docker compose up postgres');
  });
});

/** An admin whose catalog keeps answering `pids` connected, and whose terminate does `terminate`. */
function stubbornAdmin(pids: number[], terminate: () => Promise<unknown>) {
  const asked: string[] = [];
  const admin = ((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    asked.push(text);
    return text.includes('pg_terminate_backend')
      ? terminate()
      : Promise.resolve(pids.map((pid) => ({ pid })));
  }) as unknown;
  return { admin, asked };
}

describe('sever', () => {
  it('refuses by pid a connection that outlived a terminate that answered false', async () => {
    const { admin } = stubbornAdmin([41, 42], async () => [{ pg_terminate_backend: false }]);
    // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
    await expect(sever(admin as any, 'test_w_1_x')).rejects.toThrow(
      'connection(s) 41, 42 outlived',
    );
  });

  it('refuses by pid a connection whose terminate threw', async () => {
    const { admin } = stubbornAdmin([43], async () => {
      throw new Error('permission denied');
    });
    // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
    await expect(sever(admin as any, 'test_w_1_x')).rejects.toThrow('connection(s) 43 outlived');
  });

  it('answers how many it ended when none is left', async () => {
    let left = [44];
    const asked: string[] = [];
    const admin = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      asked.push(text);
      if (text.includes('pg_terminate_backend')) {
        left = [];
        return Promise.resolve([]);
      }
      return Promise.resolve(left.map((pid) => ({ pid })));
    }) as unknown;
    // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
    await expect(sever(admin as any, 'test_w_1_x')).resolves.toEqual([{ pid: 44 }]);
  });
});

/** An admin whose catalog answers `looks[n]` on its nth look at the database's sessions. */
function sessionsAdmin(looks: Array<Array<{ pid: number; app: string; kind?: string }>>) {
  let n = 0;
  const admin = (() => {
    const at = Math.min(n, looks.length - 1);
    n += 1;
    return Promise.resolve(
      (looks[at] ?? []).map((s) => ({
        kind: 'client backend',
        state: 'idle',
        query: 'SELECT 1',
        ...s,
      })),
    );
  }) as unknown;
  return { admin, looks: () => n };
}

describe('reportLingeringConnections', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names nothing for a session that leaves on a later look, as one the server is still ending does', async () => {
    vi.useFakeTimers();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, looks } = sessionsAdmin([[{ pid: 51, app: 'postgres.js' }], []]);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
      const done = reportLingeringConnections(admin as any, 'test_w_1_x');
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(looks()).toBe(2);
      expect(reported).not.toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
  });

  it('neither names nor waits on a worker of the server\u2019s own, which no file opened', async () => {
    vi.useFakeTimers();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, looks } = sessionsAdmin([[{ pid: 53, app: '', kind: 'autovacuum worker' }]]);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
      const done = reportLingeringConnections(admin as any, 'test_w_1_x');
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(looks()).toBe(1);
      expect(reported).not.toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
  });

  it('names a session of any other kind still there after fifty looks, a replication connection among them', async () => {
    vi.useFakeTimers();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, looks } = sessionsAdmin([
      [{ pid: 54, app: 'subscriber-left-here', kind: 'walsender' }],
    ]);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
      const done = reportLingeringConnections(admin as any, 'test_w_1_x');
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(looks()).toBe(50);
      expect(reported.mock.calls.flat().join('\n')).toContain(
        '1 connection(s) still open at teardown, severed now: pid 54 (walsender) subscriber-left-here, idle after "SELECT 1"',
      );
    } finally {
      reported.mockRestore();
    }
  });

  it('says by name that it could not read what is connected, rather than saying nothing', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = (() => Promise.reject(new Error('connection refused by plant'))) as unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
      await reportLingeringConnections(admin as any, 'test_w_1_x');
      expect(reported.mock.calls.flat().join('\n')).toContain(
        'test_w_1_x: could not read what is still connected at teardown, so nothing still open is named: connection refused by plant',
      );
    } finally {
      reported.mockRestore();
    }
  });

  it('names a session still there after fifty looks by pid and application', async () => {
    vi.useFakeTimers();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, looks } = sessionsAdmin([[{ pid: 52, app: 'held-here' }]]);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
      const done = reportLingeringConnections(admin as any, 'test_w_1_x');
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(looks()).toBe(50);
      expect(reported.mock.calls.flat().join('\n')).toContain(
        '1 connection(s) still open at teardown, severed now: pid 52 (client backend) held-here, idle after "SELECT 1"',
      );
    } finally {
      reported.mockRestore();
    }
  });

  it('names a parallel worker by its kind, apart from the leader whose application name it carries', async () => {
    vi.useFakeTimers();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = sessionsAdmin([
      [
        { pid: 60, app: 'leader-here' },
        { pid: 61, app: 'leader-here', kind: 'parallel worker' },
      ],
    ]);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the stub stands in for a postgres-js tag function
      const done = reportLingeringConnections(admin as any, 'test_w_1_x');
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(reported.mock.calls.flat().join('\n')).toContain(
        '2 connection(s) still open at teardown, severed now: pid 60 (client backend) leader-here, idle after "SELECT 1"; pid 61 (parallel worker) leader-here, idle after "SELECT 1"',
      );
    } finally {
      reported.mockRestore();
    }
  });
});
