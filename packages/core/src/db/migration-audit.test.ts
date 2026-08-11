import { describe, expect, it } from 'vitest';
import { describeUnrecorded, findUnrecordedMigrations } from './migration-audit.js';

const e = (idx: number, when: number, tag = `m${idx}`) => ({ idx, when, tag });

describe('findUnrecordedMigrations', () => {
  it('reports nothing when every journal entry has a ledger row', () => {
    const journal = [e(0, 100), e(1, 200), e(2, 300)];
    expect(findUnrecordedMigrations(journal, [300, 100, 200])).toEqual([]);
  });

  // cm:guard this is the ISS-807 shape: 0166 landed with a `when` above the two entries that followed it, so the migrator skipped them and still reported success. The audit must name them.
  it('catches entries the migrator skipped because an earlier one sits above them', () => {
    const journal = [
      e(0, 100),
      e(1, 900, 'high_watermark'),
      e(2, 200, 'skipped_a'),
      e(3, 300, 'skipped_b'),
    ];
    const missing = findUnrecordedMigrations(journal, [100, 900]);
    expect(missing.map((m) => m.tag)).toEqual(['skipped_a', 'skipped_b']);
  });

  it('returns them in idx order regardless of journal or db ordering', () => {
    const journal = [e(5, 500), e(1, 100), e(3, 300)];
    const missing = findUnrecordedMigrations(journal, []);
    expect(missing.map((m) => m.idx)).toEqual([1, 3, 5]);
  });

  it('tolerates created_at arriving as strings (bigint over the wire)', () => {
    const journal = [e(0, 100), e(1, 200)];
    expect(findUnrecordedMigrations(journal, ['100', '200'] as unknown as number[])).toEqual([]);
  });

  it('ignores recorded rows with no journal entry — a removed migration is not a failure', () => {
    expect(findUnrecordedMigrations([e(0, 100)], [100, 999])).toEqual([]);
  });

  it('treats an empty ledger as everything unrecorded, not as everything fine', () => {
    expect(findUnrecordedMigrations([e(0, 100), e(1, 200)], [])).toHaveLength(2);
  });

  it('is vacuously clean for an empty journal', () => {
    expect(findUnrecordedMigrations([], [100])).toEqual([]);
  });
});

describe('describeUnrecorded', () => {
  it('names each unrecorded migration and refuses to claim its DDL is missing', () => {
    const text = describeUnrecorded([e(2, 200, 'reconcile_acknowledge')]);
    expect(text).toContain('reconcile_acknowledge');
    expect(text).toContain('idx 2');
    expect(text).toContain('__drizzle_migrations');
    // cm:guard the message must NOT assert the migration did not run — on forge-beta three unrecorded entries have all their tables present
    expect(text).toMatch(/does NOT prove their DDL is missing/i);
    expect(text).toMatch(/reports success when it skips/i);
  });
});
