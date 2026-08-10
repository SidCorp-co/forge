import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'pepper-test-at-least-32-chars-long-aaaaa';

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER },
}));

const insertReturning = vi.fn();
const insertValues = vi.fn((..._args: unknown[]) => ({ returning: insertReturning }));
const selectWhere = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValues })),
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const { issueDeviceToken, verifyDeviceToken } = await import('./deviceToken.js');
const { db } = await import('../db/client.js');

type DeviceRow = {
  id: string;
  ownerId: string;
  name: string;
  platform: 'macos' | 'linux' | 'windows';
  agentVersion: string | null;
  tokenHash: string;
  tokenPrefix: string;
  disabledAt: null,
  status: 'online' | 'offline' | 'revoked';
  lastSeenAt: Date | null;
  pairedAt: Date;
  capabilities: unknown;
  createdAt: Date;
};

function rowFromInsert(overrides: Partial<DeviceRow> = {}): DeviceRow {
  const values = insertValues.mock.calls.at(-1)?.[0] as {
    ownerId: string;
    name: string;
    platform: DeviceRow['platform'];
    agentVersion: string | null;
    tokenHash: string;
    tokenPrefix: string;
    disabledAt: null,
    capabilities: unknown;
  };
  return {
    id: 'dev-generated',
    ownerId: values.ownerId,
    name: values.name,
    platform: values.platform,
    agentVersion: values.agentVersion,
    tokenHash: values.tokenHash,
    tokenPrefix: values.tokenPrefix,
    disabledAt: null,
    status: 'offline',
    lastSeenAt: null,
    pairedAt: new Date('2026-04-24T00:00:00Z'),
    capabilities: values.capabilities,
    createdAt: new Date('2026-04-24T00:00:00Z'),
    ...overrides,
  };
}

function validInput() {
  return {
    ownerId: 'user-1',
    name: 'macbook',
    platform: 'macos' as const,
    agentVersion: '0.1.0',
    capabilities: { claudeCode: { version: '2.0.0', available: true } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertReturning.mockReset();
  selectWhere.mockReset();
});

describe('issueDeviceToken', () => {
  it('returns a high-entropy plaintext (>=256 bits, base64url) and the inserted device', async () => {
    insertReturning.mockImplementationOnce(async () => [rowFromInsert()]);

    const { plaintext, device } = await issueDeviceToken(validInput());

    expect(plaintext.length).toBeGreaterThanOrEqual(43);
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(device.tokenPrefix).toBe(plaintext.slice(0, 8));
    expect(device.tokenHash.startsWith('$argon2id$')).toBe(true);
  });

  it('produces a different plaintext each call', async () => {
    insertReturning.mockImplementation(async () => [rowFromInsert()]);
    const a = await issueDeviceToken(validInput());
    const b = await issueDeviceToken(validInput());
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  it('inserts only tokenPrefix + argon2id hash (never plaintext)', async () => {
    insertReturning.mockImplementationOnce(async () => [rowFromInsert()]);

    const { plaintext } = await issueDeviceToken(validInput());

    expect(db.insert).toHaveBeenCalledTimes(1);
    const values = insertValues.mock.calls[0]?.[0] as {
      tokenHash: string;
      tokenPrefix: string;
      disabledAt: null,
      ownerId: string;
      name: string;
      platform: string;
      agentVersion: string | null;
      capabilities: unknown;
    };
    expect(values.tokenPrefix).toBe(plaintext.slice(0, 8));
    expect(values.tokenHash.startsWith('$argon2id$')).toBe(true);
    expect(values.tokenHash).not.toContain(plaintext);
    expect(values.ownerId).toBe('user-1');
    expect(values.name).toBe('macbook');
    expect(values.platform).toBe('macos');
    expect(values.agentVersion).toBe('0.1.0');
    expect(values.capabilities).toEqual({ claudeCode: { version: '2.0.0', available: true } });
  });

  it('defaults agentVersion and capabilities to null when omitted', async () => {
    insertReturning.mockImplementationOnce(async () => [rowFromInsert()]);

    await issueDeviceToken({ ownerId: 'user-1', name: 'linux-box', platform: 'linux' });

    const values = insertValues.mock.calls[0]?.[0] as {
      agentVersion: string | null;
      capabilities: unknown;
    };
    expect(values.agentVersion).toBeNull();
    expect(values.capabilities).toBeNull();
  });

  it('throws if the INSERT returns no row', async () => {
    insertReturning.mockImplementationOnce(async () => []);

    await expect(issueDeviceToken(validInput())).rejects.toThrow(/no row/);
  });
});

describe('verifyDeviceToken', () => {
  it('returns the Device on a valid token', async () => {
    insertReturning.mockImplementationOnce(async () => [rowFromInsert({ status: 'online' })]);
    const { plaintext, device } = await issueDeviceToken(validInput());
    selectWhere.mockResolvedValueOnce([device]);

    const result = await verifyDeviceToken(plaintext);
    expect(result).toEqual(device);
  });

  it('returns null on an unknown token (no prefix match)', async () => {
    selectWhere.mockResolvedValueOnce([]);
    const result = await verifyDeviceToken('aaaaaaaabbbbbbbbccccccccddddddddeeeeeeefff');
    expect(result).toBeNull();
  });

  it('returns null when prefix matches but hash does not', async () => {
    insertReturning.mockImplementationOnce(async () => [rowFromInsert({ status: 'online' })]);
    const { plaintext, device } = await issueDeviceToken(validInput());
    selectWhere.mockResolvedValueOnce([device]);

    const tampered = `${plaintext.slice(0, 8)}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    const result = await verifyDeviceToken(tampered);
    expect(result).toBeNull();
  });

  it('returns null on malformed input without querying the DB', async () => {
    expect(await verifyDeviceToken('')).toBeNull();
    expect(await verifyDeviceToken('short')).toBeNull();
    expect(await verifyDeviceToken(undefined)).toBeNull();
    expect(await verifyDeviceToken(null)).toBeNull();
    expect(await verifyDeviceToken(12345)).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns null for a revoked device (short-circuits without argon2 verify)', async () => {
    insertReturning.mockImplementationOnce(async () => [rowFromInsert({ status: 'online' })]);
    const { plaintext, device } = await issueDeviceToken(validInput());
    selectWhere.mockResolvedValueOnce([{ ...device, status: 'revoked' }]);

    const result = await verifyDeviceToken(plaintext);
    expect(result).toBeNull();
  });

  it('returns null when the stored hash is malformed (argon2.verify throws)', async () => {
    const plaintext = 'yyyyyyyybbbbbbbbccccccccddddddddeeeeeeefff';
    selectWhere.mockResolvedValueOnce([
      {
        id: 'dev-bad',
        ownerId: 'user-1',
        name: 'corrupted',
        platform: 'macos',
        agentVersion: null,
        tokenHash: 'not-a-valid-hash',
        tokenPrefix: 'yyyyyyyy',
        disabledAt: null,
        status: 'online',
        lastSeenAt: null,
        pairedAt: new Date('2026-04-24T00:00:00Z'),
        capabilities: null,
        createdAt: new Date('2026-04-24T00:00:00Z'),
      },
    ]);
    const result = await verifyDeviceToken(plaintext);
    expect(result).toBeNull();
  });

  it('resolves prefix collisions and returns the correct device', async () => {
    insertReturning.mockImplementationOnce(async () => [
      rowFromInsert({ id: 'dev-a', status: 'online' }),
    ]);
    const a = await issueDeviceToken(validInput());
    insertReturning.mockImplementationOnce(async () => [
      rowFromInsert({ id: 'dev-b', status: 'online' }),
    ]);
    const b = await issueDeviceToken(validInput());

    const sharedPrefix = b.plaintext.slice(0, 8);
    selectWhere.mockResolvedValueOnce([
      { ...a.device, tokenPrefix: sharedPrefix },
      { ...b.device, tokenPrefix: sharedPrefix },
    ]);

    const result = await verifyDeviceToken(b.plaintext);
    expect(result?.id).toBe('dev-b');
  });

  it('looks up by tokenPrefix only (indexed path, not a scan)', async () => {
    selectWhere.mockResolvedValueOnce([]);
    await verifyDeviceToken('prefix01restoftoken_xxxxxxxxxxxxxxxxxxxxx');
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(selectFrom).toHaveBeenCalledTimes(1);
    expect(selectWhere).toHaveBeenCalledTimes(1);
  });
});
