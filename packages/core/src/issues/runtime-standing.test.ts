/**
 * ISS-845: a runtime verdict that declares `covers` is carried to a served commit as any other pass
 * is, except where a file between the two falls under what it covers, or where the served commit
 * descends from it and what changed between was not read. Pure: the carriage is handed in, as the
 * release pass reads it (`release-batch/runtime-weighing.ts`).
 */

import type { ServingReading } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { weighVerdict } from './runtime-standing.js';
import { type Carriage, carriageKey, type Weighing } from './weighing.js';

const JUDGED = 'a'.repeat(40);
const SERVED = 'b'.repeat(40);
const serving: ServingReading = {
  kind: 'serving',
  served: [{ commit: SERVED, where: 'https://app.example' }],
  unread: [],
  readAt: '2026-11-01T00:00:00Z',
};
const at = { kind: 'runtime', value: JUDGED } as const;
const owed = { deployment: true, declared: [], unread: null };

const weighing = (carriage: Carriage): Weighing => ({
  read: true,
  runtimes: [],
  changed: new Map(),
  carriage: new Map([[carriageKey(JUDGED, SERVED), carriage]]),
});

const weigh = (carriage: Carriage, covers: readonly string[] | null) =>
  weighVerdict(at, serving, { source: null }, owed, weighing(carriage), null, covers);

describe('a covering runtime pass on a served commit', () => {
  it('stands where the served commit descends from it and it covers nothing named', () => {
    expect(weigh({ kind: 'descends' }, null).standing).toBe('stands');
  });

  it('does not stand where it descends but what changed between was not read', () => {
    const w = weigh({ kind: 'descends' }, ['src/billing/']);
    expect(w.standing).toBe('superseded');
    expect(w.beside.join(' ')).toContain(
      'descends from it, and it covers `src/billing/`: what changed between them was not read',
    );
  });

  it('does not stand where a file between falls under what it covers, naming the file', () => {
    const w = weigh({ kind: 'differs', paths: ['docs/a.md', 'src/billing/tax.ts'] }, [
      'src/billing',
    ]);
    expect(w.standing).toBe('superseded');
    expect(w.beside.join(' ')).toContain(
      'changes 1 file: `src/billing/tax.ts` under what it covers (`src/billing`)',
    );
  });

  it('stands where the served commit differs only in files it neither runs against nor covers', () => {
    const w = weigh({ kind: 'descends', paths: ['docs/a.md'] }, ['src/billing/']);
    expect(w.standing).toBe('stands');
  });
});
