/**
 * FB-273: the take a run session makes refuses an issue at rest by name, reading the one list the
 * verdict reads. A run over issues all over takes nothing and is never asked it (ISS-576,
 * run-declared-over-closed-e2e).
 *
 * @direct-test-of packages/runner/crates/runner-transport/src/status.rs
 */

import { readFileSync } from 'node:fs';
import { ISSUE_RESTING_STATUSES } from '@forge/contracts/issue-machine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';

let rows: Array<Record<string, unknown>> = [];

vi.mock('../db/client.js', () => ({
  db: { execute: vi.fn(async () => rows) },
}));
vi.mock('./ports.js', () => ({
  assertDesignApprovedForIssue: vi.fn(),
  assertDesignsApprovedForSeqs: vi.fn(),
  // no project document: today's gates (REQ-76 BC-2), every take check enforced
  readProjectDocument: vi.fn(async () => null),
}));
vi.mock('./contract-waits.js', () => ({
  assertContractWaitsSettledForIssue: vi.fn(),
  assertContractWaitsSettledForSeqs: vi.fn(),
}));
vi.mock('./patterns.js', () => ({
  assertPatternReviewsSettledForIssue: vi.fn(),
  assertPatternReviewsSettledForSeqs: vi.fn(),
}));
vi.mock('./issue-scope.js', () => ({ refuseScopeHeldForKeys: vi.fn() }));

const { refuseHeldTakeForSeqs } = await import('./blocked-by.js');

const issue = (seq: number, status: string) => ({
  id: `id-${seq}`,
  project_id: 'p',
  status,
  iss_seq: seq,
  issue_prefix: null,
});

async function refusalOf(seqs: number[]): Promise<unknown> {
  try {
    await refuseHeldTakeForSeqs('p', seqs);
    return null;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  rows = [];
});

describe('a run over an issue at rest', () => {
  it.each(['closed', 'dropped', 'needs_info', 'on_hold'])(
    'is refused at declare when the issue is %s, naming the status and the way back',
    async (status) => {
      rows = [issue(23, status)];
      const err = await refusalOf([23]);
      expect(
        isRefusal(err, 'ISSUE_AT_REST'),
        `a run declared over an issue at ${status} was accepted; an issue at rest is refused at declare`,
      ).toBe(true);
      const detail = isRefusal(err) ? (err.refusals[0]?.detail ?? '') : '';
      expect(detail).toContain('ISS-23');
      expect(detail).toContain(`\`${status}\``);
      // never "reopen it to judge it": an issue that is over is judged by a `qa` run (forge-core-61, 2026-10-29)
      expect(detail).toMatch(status === 'closed' || status === 'dropped' ? /--role qa/ : /park/);
      expect(detail).not.toMatch(/Reopen it first/);
    },
  );

  it('refuses every resting member of a group, and only those', async () => {
    rows = [issue(11, 'open'), issue(12, 'closed'), issue(13, 'dropped')];
    const err = await refusalOf([11, 12, 13]);
    expect(
      isRefusal(err, 'ISSUE_AT_REST'),
      'a group holding closed and dropped issues was accepted; an issue at rest is refused at declare',
    ).toBe(true);
    const named = isRefusal(err) ? err.refusals.map((r) => r.detail) : [];
    expect(named).toHaveLength(2);
    expect(named.join(' ')).not.toContain('ISS-11 ');
  });

  it('opens over an issue that is not at rest', async () => {
    rows = [issue(7, 'open'), issue(8, 'in_progress'), issue(9, 'reopen')];
    expect(await refusalOf([7, 8, 9])).toBeNull();
  });

  it("reads the same list as the recovery verdict's stale declaration", () => {
    expect([...ISSUE_RESTING_STATUSES].sort()).toEqual(
      ['closed', 'dropped', 'needs_info', 'on_hold'].sort(),
    );
    const verdictRead = readFileSync(new URL('./issue-lease-read.ts', import.meta.url), 'utf8');
    expect(verdictRead).toContain('list(ISSUE_RESTING_STATUSES)');
  });

  it('is the code the runner refuses a declaration by', () => {
    const status = readFileSync(
      new URL('../../../runner/crates/runner-transport/src/status.rs', import.meta.url),
      'utf8',
    );
    expect(status).toMatch(/pub const AT_REST_CODE: &str = "ISSUE_AT_REST";/u);
  });
});
