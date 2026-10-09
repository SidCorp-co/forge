import type { CheckRun } from '@forge/contracts/check-runs';
import { describe, expect, it } from 'vitest';
import { issueChecksViewOf, type StoredCheckRun, sortSentChecks } from './check-run-rules.js';

const ISSUE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HEAD = 'a'.repeat(40);

const sent = (id: string, over: Partial<CheckRun> = {}): CheckRun => ({
  id,
  kind: 'tests',
  name: 'direct-tests',
  scope: '@forge/core',
  command: 'vitest run',
  files: ['packages/core/src/a.test.ts'],
  result: 'pass',
  durationMs: 1200,
  startedAt: '2026-10-09T06:00:00.000Z',
  ...over,
});

const stored = (c: CheckRun, over: Partial<StoredCheckRun> = {}): StoredCheckRun => ({
  id: c.id,
  issueId: ISSUE,
  kind: c.kind,
  name: c.name,
  scope: c.scope,
  command: c.command,
  files: c.files,
  result: c.result,
  durationMs: c.durationMs,
  startedAt: new Date(c.startedAt),
  headSha: HEAD,
  note: c.note ?? null,
  runSessionId: null,
  via: 'report',
  createdAt: new Date('2026-10-09T06:01:00.000Z'),
  ...over,
});

const sort = (checks: CheckRun[], rows: StoredCheckRun[]) =>
  sortSentChecks({
    issueId: ISSUE,
    head: HEAD,
    checks,
    stored: rows,
    issueKeys: new Map([[OTHER, 'ISS-9']]),
  });

describe('which sent checks are written', () => {
  it('writes every check not yet recorded', () => {
    const out = sort([sent('a'), sent('b')], []);
    expect(out).toEqual({ ok: true, fresh: [sent('a'), sent('b')], again: 0 });
  });

  it('writes nothing for a check sent again as it was: one check is one record', () => {
    const out = sort([sent('a'), sent('b')], [stored(sent('a'))]);
    expect(out).toEqual({ ok: true, fresh: [sent('b')], again: 1 });
  });

  it('refuses an id recorded as another check, naming where and what it holds', () => {
    const out = sort([sent('b'), sent('a', { durationMs: 99 })], [stored(sent('a'))]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0]).toMatchObject({ code: 'CHECK_RUN_CONFLICT', path: '/checks/1/id' });
    expect(out.refusals[0]?.detail).toContain('`direct-tests` (tests, @forge/core)');
  });

  it("refuses an id another issue's check holds, naming that issue by its key", () => {
    const out = sort([sent('a')], [stored(sent('a'), { issueId: OTHER })]);
    expect(out.ok ? '' : out.refusals[0]?.detail).toContain('already recorded on ISS-9');
  });

  it('refuses the same check sent against another head', () => {
    const out = sort([sent('a')], [stored(sent('a'), { headSha: 'b'.repeat(40) })]);
    expect(out.ok).toBe(false);
  });
});

describe('the view the issue page reads', () => {
  it('lists the checks newest first and sums each kind, every kind present', () => {
    const view = issueChecksViewOf(ISSUE, [
      stored(sent('a', { startedAt: '2026-10-09T06:00:00.000Z', durationMs: 4000 })),
      stored(
        sent('b', {
          kind: 'typecheck',
          name: 'typecheck',
          startedAt: '2026-10-09T07:00:00.000Z',
          durationMs: 3000,
        }),
        { runSessionId: OTHER },
      ),
    ]);
    expect(view.checks.map((c) => c.id)).toEqual(['b', 'a']);
    expect(view.checks[0]).toMatchObject({ runSessionId: OTHER, head: HEAD, durationMs: 3000 });
    expect(view.totalMs).toBe(7000);
    expect(view.kinds.map((k) => k.kind)).toEqual([
      'tests',
      'typecheck',
      'probes',
      'review',
      'conformance',
      'base',
    ]);
    expect(view.kinds[0]).toMatchObject({ checks: 1, totalMs: 4000 });
  });
});
