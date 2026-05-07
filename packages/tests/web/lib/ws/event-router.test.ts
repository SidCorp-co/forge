import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { routeEvent } from '@/lib/ws/event-router';

function makeClient() {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, 'invalidateQueries');
  return { qc, spy };
}

describe('routeEvent — dependencyChanged', () => {
  it('invalidates issue queries for both sides of the edge (prefix covers dependencies)', () => {
    const { qc, spy } = makeClient();
    routeEvent(
      {
        event: 'dependencyChanged',
        data: { fromIssueId: 'a', toIssueId: 'b', kind: 'blocks' },
        timestamp: '2026-05-07T00:00:00Z',
      },
      qc,
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['issue', 'a'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['issue', 'b'] });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('skips invalidations when payload is missing ids', () => {
    const { qc, spy } = makeClient();
    routeEvent(
      { event: 'dependencyChanged', data: {}, timestamp: '2026-05-07T00:00:00Z' },
      qc,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
