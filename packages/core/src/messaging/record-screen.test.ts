import { KERNEL_ONLY_RECORD_KINDS, RECORD_EVENT_KINDS } from '@forge/contracts/record-events';
import { describe, expect, it } from 'vitest';
import { RECORD_DESTINATIONS, recordInCommentRefusal } from './record-screen.js';

const EVENTS = 'POST /api/issues/:id/events';

describe('where a record-in-comment refusal sends a record', () => {
  // The events route refuses a kernel-only kind (EVENT_KIND_KERNEL_ONLY), so pointing a fence of one
  // there sends the writer from one refusal to the next.
  it.each(KERNEL_ONLY_RECORD_KINDS)('sends a `%s` record to the act that writes it', (kind) => {
    expect(RECORD_DESTINATIONS.get(kind)).not.toBe(EVENTS);
  });

  it('sends a verdict to the verdicts route', () => {
    expect(RECORD_DESTINATIONS.get('verdict')).toBe('POST /api/issues/:id/verdicts');
  });

  it('sends every other kind to the events route', () => {
    const narrated = RECORD_EVENT_KINDS.filter(
      (kind) => !(KERNEL_ONLY_RECORD_KINDS as readonly string[]).includes(kind),
    );
    expect(narrated.map((kind) => RECORD_DESTINATIONS.get(kind))).toEqual(
      narrated.map(() => EVENTS),
    );
  });

  it('names no store for a kind outside the set, and no route core does not mount', () => {
    const record = {
      kind: 'attribute',
      contract: 1,
      fields: [],
      lead: null,
      absent: [],
      at: 0,
      to: 0,
    };
    const why = recordInCommentRefusal(record)?.why ?? '';
    expect(why).toContain('no store holds a `attribute` record');
    expect(why).not.toContain('/attributes');
  });
});
