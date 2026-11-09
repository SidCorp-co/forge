// @direct-test-of scripts/check-outbox-consumers.mjs

import { describe, expect, it } from 'vitest';
import { readConsumerCounts, readEventTypes, unconsumedFaults } from './outbox-consumers.mjs';

const EVENTS = `export const OUTBOX_EVENT_TYPES = ["issue.created", "release.committed", "source.merged"] as const;`;

function judge(consumers) {
  const { types } = readEventTypes('events.ts', EVENTS);
  const read = readConsumerCounts('consumers.ts', consumers);
  return read.unreadable ?? unconsumedFaults(types, read.counts);
}

describe('an outbox event type names a consumer (REQ-12 BC-18)', () => {
  it('passes a registry naming a consumer for every type', () => {
    expect(
      judge(
        `export const OUTBOX_CONSUMERS = { "issue.created": ["a", "b"], "release.committed": ["release-tag"], "source.merged": ["c"] } as const satisfies X;`,
      ),
    ).toEqual([]);
  });

  it('refuses an empty list and an absent type, each by name', () => {
    expect(
      judge(
        `export const OUTBOX_CONSUMERS = { "issue.created": ["a"], "release.committed": [] } as const satisfies X;`,
      ),
    ).toEqual([
      'OUTBOX_EVENT_UNCONSUMED release.committed',
      'OUTBOX_EVENT_UNCONSUMED source.merged',
    ]);
  });

  it('refuses to read a list it cannot count, rather than reading it as empty or full', () => {
    expect(
      judge(`export const OUTBOX_CONSUMERS = { "issue.created": [...others] } as const;`),
    ).toMatch(
      /OUTBOX_CONSUMERS\["issue.created"\] in consumers.ts is not a list of consumer names/,
    );
    expect(judge(`export const OUTBOX_CONSUMERS = { ...base } as const;`)).toMatch(
      /holds \.\.\.base/,
    );
    expect(readEventTypes('events.ts', 'export const OTHER = [];').unreadable).toBe(
      'events.ts declares no OUTBOX_EVENT_TYPES',
    );
  });
});
