import { describe, expect, it } from 'vitest';
import { foldSessionFailures } from './pulse-folds.js';

const PROMPT =
  "You are the Forge product-map refresh agent. Your job: keep this project's curated PRODUCT map current";

describe('foldSessionFailures (ISS-1157)', () => {
  it('counts text outside the cause set as unclassified, and returns none of it', () => {
    const out = foldSessionFailures([
      { reason: PROMPT, count: 1 },
      {
        reason: 'failed to start chat turn: io error: No space left on device (os error 28)',
        count: 2,
      },
    ]);
    expect(out).toEqual([{ reason: 'unclassified', count: 3 }]);
    expect(JSON.stringify(out)).not.toContain('No space left');
  });

  it('counts each legacy alias under the cause it resolves to', () => {
    expect(
      foldSessionFailures([
        { reason: 'job_failed', count: 4 },
        { reason: 'usage_limit', count: 3 },
        { reason: 'ws-publish-failed', count: 2 },
      ]),
    ).toEqual([
      { reason: 'unclassified', count: 4 },
      { reason: 'provider_usage_limit', count: 3 },
      { reason: 'ws_publish_failed', count: 2 },
    ]);
  });

  it('counts a null reason as unclassified', () => {
    expect(foldSessionFailures([{ reason: null, count: 5 }])).toEqual([
      { reason: 'unclassified', count: 5 },
    ]);
  });

  it('sums every raw value that resolves to one key into one row', () => {
    expect(
      foldSessionFailures([
        { reason: null, count: 1 },
        { reason: 'job_failed', count: 2 },
        { reason: '**bold** agent reply', count: 3 },
        { reason: 'unclassified', count: 4 },
        { reason: 'queue_timeout', count: 1 },
      ]),
    ).toEqual([
      { reason: 'unclassified', count: 10 },
      { reason: 'queue_timeout', count: 1 },
    ]);
  });

  it('orders by count descending, and equal counts by key', () => {
    expect(
      foldSessionFailures([
        { reason: 'queue_timeout', count: 2 },
        { reason: 'pipeline_failed', count: 2 },
        { reason: 'provider_overloaded', count: 7 },
        { reason: 'agent_skill_missing', count: 2 },
      ]),
    ).toEqual([
      { reason: 'provider_overloaded', count: 7 },
      { reason: 'agent_skill_missing', count: 2 },
      { reason: 'pipeline_failed', count: 2 },
      { reason: 'queue_timeout', count: 2 },
    ]);
  });

  it('returns an empty list for no failed sessions', () => {
    expect(foldSessionFailures([])).toEqual([]);
  });
});
