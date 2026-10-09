/**
 * The refusals a declared run queues behind are the ones the box reads as a hold. Core's
 * `QUEUED_BEHIND` and the runner's `HELD_CODES` are one list in two languages: a code core queues
 * and the box does not read as held is a declaration the box writes past at declare time (the
 * preflight's hold read as "core could not answer"), so the master is never told its dispatch
 * cannot start. That is how PATTERN_REVIEW_PENDING and ISSUE_SCOPE_HELD would have shipped.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RefusalError } from '../lib/refusal.js';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../agent-sessions/index.js', () => ({}));
vi.mock('../pipeline/index.js', () => ({}));

const { QUEUED_BEHIND, queueableRefusal } = await import('./run-session-queued.js');

/** The codes the runner's `HELD_CODES` lists, read from its source. */
function heldCodes(): string[] {
  const source = readFileSync(
    new URL('../../../runner/crates/runner-transport/src/status.rs', import.meta.url),
    'utf8',
  );
  const list = /pub const HELD_CODES: &\[&str\] = &\[([^\]]*)\];/u.exec(source)?.[1];
  if (list === undefined) throw new Error('status.rs declares no HELD_CODES list');
  return [...list.matchAll(/"([A-Z_]+)"/gu)].map((m) => m[1] as string);
}

describe('the holds a declared run queues behind', () => {
  it('are exactly the codes the runner reads as held', () => {
    expect(heldCodes().sort()).toEqual(Object.keys(QUEUED_BEHIND).sort());
  });

  it('queue a scope hold behind scope_held, named as core refused it', () => {
    const refusal = new RefusalError(
      [{ code: 'ISSUE_SCOPE_HELD', path: '', detail: 'ISS-2 shares module issues with ISS-1' }],
      'ISSUE_SCOPE_HELD',
    );
    expect(queueableRefusal(refusal)).toEqual({
      code: 'ISSUE_SCOPE_HELD',
      gate: 'scope_held',
      detail: 'ISS-2 shares module issues with ISS-1',
    });
  });
});
