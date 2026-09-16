import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

/**
 * The db every test here shares: a proxy that throws on ANY access.
 *
 * That is the assertion, not a convenience. "Writes no row" is cheap to fake — a mock
 * that records calls passes just as well when the gate runs AFTER the insert and the
 * insert is simply ignored. A db that cannot be touched at all fails the moment the seam
 * moves below the first query, which is exactly the regression this file exists to catch.
 */
vi.mock('../db/client.js', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('the database was reached');
      },
    },
  ),
}));

const suppressed = new Set<string>();
vi.mock('./emission-switch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./emission-switch.js')>();
  return {
    ...real,
    SUPPRESSED_TYPES: suppressed,
    emissionAllowed: (t: string) => !suppressed.has(t),
    noteSuppressed: () => {},
  };
});

const { recordAndDeliver } = await import('./deliver.js');
const { emissionAllowed, SUPPRESSED_TYPES } =
  await vi.importActual<typeof import('./emission-switch.js')>('./emission-switch.js');
const { notificationTypes } = await import('../db/schema.js');

/**
 * Criterion 6 — at the head that lands last, the switch suppresses no type.
 *
 * These read the REAL module (`importActual`); every test below reads the mocked one,
 * because a switch whose set is empty cannot demonstrate that its seam still bites.
 */
describe('the emission switch, as this deployment ships it', () => {
  it('suppresses no type', () => {
    expect([...SUPPRESSED_TYPES]).toEqual([]);
  });

  it('allows every declared type', () => {
    const refused = notificationTypes.filter((t) => !emissionAllowed(t));
    expect(refused).toEqual([]);
  });
});

/** The mechanism the empty set leaves behind — proved with the set made non-empty. */
describe('the seam still refuses a type an operator turns off', () => {
  it('writes nothing and returns null, without reaching the database', async () => {
    suppressed.clear();
    suppressed.add('issue_stranded');
    const result = await recordAndDeliver({
      recipients: ['u1'],
      type: 'issue_stranded',
      title: 'ISS-1 is waiting on you',
    });
    expect(result).toBeNull();
  });

  it('reaches the database for a type that is not suppressed', async () => {
    suppressed.clear();
    await expect(
      recordAndDeliver({ recipients: ['u1'], type: 'ops_alert', title: 'Orphan jobs detected' }),
    ).rejects.toThrow('the database was reached');
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
    join('notifications', 'deliver.ts'),
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
      expect({ writer, consults: src.includes('emissionAllowed(') }).toEqual({
        writer,
        consults: true,
      });
    }
  });
});
