// A check the scripts time is a check run as the tracker records it (REQ-36 BC-14, ISS-474;
// `packages/contracts/src/check-runs.ts`): its own id, its kind, when it started and how long it took.

import { describe, expect, it } from 'vitest';
import { check, describeChecks, run } from './direct-test-run.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a timed check', () => {
  const made = () =>
    check({
      name: 'typecheck',
      kind: 'typecheck',
      scope: 'typescript',
      command: 'node scripts/tc-changed.mjs',
      files: [],
      result: 'pass',
      startedAt: Date.parse('2026-10-09T06:00:00.000Z'),
      durationMs: 1500,
    });

  it('carries its kind, its start as ISO 8601 and its duration in milliseconds', () => {
    expect(made()).toEqual({
      id: expect.stringMatching(UUID),
      kind: 'typecheck',
      name: 'typecheck',
      scope: 'typescript',
      command: 'node scripts/tc-changed.mjs',
      files: [],
      result: 'pass',
      durationMs: 1500,
      startedAt: '2026-10-09T06:00:00.000Z',
    });
  });

  it('has an id of its own, so two checks are two records and a resend is one', () => {
    expect(made().id).not.toBe(made().id);
  });

  it('keeps a note only where one was given', () => {
    expect(made()).not.toHaveProperty('note');
    expect(check({ ...made(), startedAt: 0, note: 'nothing to run' }).note).toBe('nothing to run');
  });
});

describe('running one command', () => {
  it('says when it started and how long it took', () => {
    const before = Date.now();
    const r = run(['node', '-e', ''], process.cwd(), { capture: true });
    expect(r.ok).toBe(true);
    expect(r.startedAt).toBeGreaterThanOrEqual(before);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('prints each check with its duration in seconds', () => {
    const [line] = describeChecks([
      { name: 'verify', scope: 'workspace', result: 'pass', durationMs: 61000, files: [] },
    ]);
    expect(line).toContain('61.0s');
  });
});
