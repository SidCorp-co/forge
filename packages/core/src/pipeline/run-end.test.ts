/**
 * ISS-928: no writer ends a run `failed` with nothing on record. A close is a `RunEnd`, which pairs a
 * `failed` end with its cause and refuses a cause on any other end, so a writer that drops the cause
 * does not compile; a cast around the type is still refused at run time, naming the writer.
 *
 * @direct-test-of packages/core/src/pipeline/runs-cascade.ts
 * @direct-test-of packages/core/src/pipeline/runs.ts
 */

import { describe, expect, it } from 'vitest';
import { type RunEnd, runEndOf } from './runs-cascade.js';

const cause = { code: 'deploy_failed', detail: 'the deploy of production failed' };

describe('a run end: a failed one names its cause, and only a failed one carries one', () => {
  it('does not compile a failed end without a cause, nor a completed or cancelled end with one', () => {
    // @ts-expect-error a failed end that says nothing of why
    const silent: RunEnd = { to: 'failed' };
    // @ts-expect-error a completed end carrying a failure cause
    const completed: RunEnd = { to: 'completed', cause };
    // @ts-expect-error a cancelled end carrying a failure cause
    const cancelled: RunEnd = { to: 'cancelled', cause };
    const named: RunEnd = { to: 'failed', cause };
    expect([silent.to, completed.to, cancelled.to, named.cause]).toEqual([
      'failed',
      'completed',
      'cancelled',
      cause,
    ]);
  });

  it('refuses a failed end without a cause at run time, naming the writer that asked for it', () => {
    expect(() => runEndOf('failed', undefined, 'planted-writer')).toThrow(
      /planted-writer ends a run `failed` without naming why/,
    );
  });

  it('keeps the cause on a failed end, and drops one sent in case of a failure that did not come', () => {
    expect(runEndOf('failed', cause, 'runs')).toEqual({ to: 'failed', cause });
    expect(runEndOf('completed', cause, 'runs')).toEqual({ to: 'completed' });
    expect(runEndOf('cancelled', undefined, 'runs')).toEqual({ to: 'cancelled' });
  });
});
