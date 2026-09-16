import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const insertReturning = vi.fn(() => Promise.resolve([{ id: 'n1' }]));
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const insert = vi.fn(() => ({ values: insertValues }));
const selectLimit = vi.fn<() => Promise<{ notifyOnMention: boolean }[]>>(() => Promise.resolve([]));
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })), insert },
}));

const { emissionAllowed, SUPPRESSED_TYPES } = await import('./emission-switch.js');
const { createNotification } = await import('./routes.js');
const { notificationTypes } = await import('../db/schema.js');

describe('the emission switch — which types may write a row at all', () => {
  it('allows ops_alert and no other type', () => {
    const allowed = notificationTypes.filter((t) => emissionAllowed(t));
    expect(allowed).toEqual(['ops_alert']);
  });

  it('suppresses every declared type except ops_alert', () => {
    const expected = notificationTypes.filter((t) => t !== 'ops_alert');
    expect([...SUPPRESSED_TYPES].sort()).toEqual([...expected].sort());
  });
});

describe('createNotification obeys the switch', () => {
  it('writes no row and returns null for a suppressed type', async () => {
    insert.mockClear();
    const result = await createNotification({
      userId: 'u1',
      type: 'issue_stranded',
      title: 'ISS-1 is waiting on you',
    });
    expect(result).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it('writes the row for ops_alert', async () => {
    insert.mockClear();
    const result = await createNotification({
      userId: 'u1',
      type: 'ops_alert',
      title: 'Orphan jobs detected',
    });
    expect(result).toEqual({ id: 'n1' });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('writes no row for a suppressed type even when a mention preference would allow it', async () => {
    insert.mockClear();
    selectLimit.mockResolvedValueOnce([{ notifyOnMention: true }]);
    const result = await createNotification({ userId: 'u1', type: 'mention', title: '@you' });
    expect(result).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });
});

/**
 * An INVENTORY of the files allowed to write the table, not a proof that each
 * write consults the switch — a text scan cannot tell a call from a mention,
 * and this one does not claim to. What it does refuse is the thing that
 * actually goes wrong: a FOURTH producer appearing in a file nobody reviewed
 * against this gate. Adding a write to one of the three named files still needs
 * a reader; adding one anywhere else fails here naming the file.
 */
describe('only the three known files write the notifications table', () => {
  const root = join(import.meta.dirname, '..');
  const WRITERS = [
    join('notifications', 'routes.ts'),
    join('admin', 'alert-sweeper.ts'),
    join('pm', 'auto-disable.ts'),
  ];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!name.endsWith('.ts') || name.includes('.test.')) return [];
      return [full];
    });
  }

  it('no file outside the inventory writes a notifications row', () => {
    const writers: string[] = [];
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      const writes =
        /\.insert\(\s*notifications\s*\)/.test(src) || /INSERT INTO notifications/i.test(src);
      if (writes) writers.push(file.slice(root.length + 1));
    }
    expect(writers.sort()).toEqual([...WRITERS].sort());
  });

  it('each of the three consults the switch', () => {
    for (const writer of WRITERS) {
      const src = readFileSync(join(root, writer), 'utf8');
      const consults =
        writer.endsWith(join('notifications', 'routes.ts')) || src.includes('emissionAllowed(');
      expect({ writer, consults }).toEqual({ writer, consults: true });
    }
  });
});
