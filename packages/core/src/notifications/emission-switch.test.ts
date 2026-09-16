import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const insertReturning = vi.fn(() => Promise.resolve([{ id: 'n1' }]));
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const insert = vi.fn(() => ({ values: insertValues }));
const selectLimit = vi.fn(() => Promise.resolve([]));
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
 * The switch is only a silence if nothing writes the table around it. Two
 * producers do write it directly and must consult it themselves
 * (`admin/alert-sweeper.ts`, `pm/auto-disable.ts`); a third that appears later
 * and does neither is the hole this scan exists to refuse.
 */
describe('no producer writes notifications without consulting the switch', () => {
  const root = join(import.meta.dirname, '..');
  const OWNS_THE_GATE = join('notifications', 'routes.ts');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!name.endsWith('.ts') || name.includes('.test.')) return [];
      return [full];
    });
  }

  it('every file that inserts a notifications row imports emission-switch', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      const writes =
        /\.insert\(\s*notifications\s*\)/.test(src) || /INSERT INTO notifications/i.test(src);
      if (!writes) continue;
      if (file.endsWith(OWNS_THE_GATE)) continue;
      if (!src.includes('emission-switch.js')) offenders.push(file.slice(root.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
