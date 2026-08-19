import { describe, expect, it } from 'vitest';
import {
  describeUnrecorded,
  findUnrecordedMigrations,
  partitionUnrecorded,
  unrecordedSentryEvent,
} from './migration-audit.js';

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

describe('unrecordedSentryEvent', () => {
  it('builds a warning-level event for a single unrecorded entry', () => {
    const event = unrecordedSentryEvent([e(2, 200, 'reconcile_acknowledge')]);
    expect(event.level).toBe('warning');
    expect(event.tags.area).toBe('db-migrate');
    expect(event.message).toContain('1 unrecorded migration');
    expect(event.extra.count).toBe(1);
    expect(event.extra.entries).toEqual([{ tag: 'reconcile_acknowledge', idx: 2, when: 200 }]);
  });

  it('carries every entry for the ISS-807/beta 3-entry shape', () => {
    const missing = [
      e(41, 41000, '0041_pm_agent'),
      e(62, 62000, '0062_personal_access_tokens'),
      e(63, 63000, '0063_mcp_audit_log'),
    ];
    const event = unrecordedSentryEvent(missing);
    expect(event.extra.count).toBe(3);
    expect(
      (event.extra.entries as unknown[]).map((entry) => (entry as { tag: string }).tag),
    ).toEqual(['0041_pm_agent', '0062_personal_access_tokens', '0063_mcp_audit_log']);
    expect(event.extra.note).toMatch(/Unrecorded != unapplied/);
  });
});

describe('partitionUnrecorded', () => {
  it('keeps the three measured entries out of the alarm path', () => {
    const journal = [
      e(41, 1778100000000, '0041_pm_agent'),
      e(62, 1779400360000, '0062_personal_access_tokens'),
      e(63, 1779400420000, '0063_mcp_audit_log'),
    ];
    const { investigated, unexpected } = partitionUnrecorded(journal, []);

    expect(investigated.map((m) => m.tag)).toEqual([
      '0041_pm_agent',
      '0062_personal_access_tokens',
      '0063_mcp_audit_log',
    ]);
    expect(unexpected).toEqual([]);
  });

  // cm:guard the whole point of the baseline: before it, a fourth unrecorded entry surfaced only as the count going 3 -> 4 in a warning that fired on every boot
  it('surfaces a NEW unrecorded entry alongside the baselined ones', () => {
    const journal = [
      e(41, 1778100000000, '0041_pm_agent'),
      e(200, 1790000000000, '0200_something_new'),
    ];
    const { investigated, unexpected } = partitionUnrecorded(journal, []);

    expect(investigated.map((m) => m.tag)).toEqual(['0041_pm_agent']);
    expect(unexpected.map((m) => m.tag)).toEqual(['0200_something_new']);
  });

  it('reports a baselined entry as neither once its ledger row exists', () => {
    const journal = [e(41, 1778100000000, '0041_pm_agent')];
    const { investigated, unexpected } = partitionUnrecorded(journal, [1778100000000]);

    expect(investigated).toEqual([]);
    expect(unexpected).toEqual([]);
  });
});
