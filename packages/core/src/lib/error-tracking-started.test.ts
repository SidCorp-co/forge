import { describe, expect, it, vi } from 'vitest';
import { provideErrorTracker, reportStarted } from './error-tracking.js';

describe('reportStarted (ISS-939)', () => {
  it('sends one info event naming the version and commit when a tracker is installed', () => {
    const captureMessage = vi.fn();
    provideErrorTracker({
      captureException: vi.fn(),
      captureMessage,
      addBreadcrumb: vi.fn(),
      flush: vi.fn(async () => true),
    });
    reportStarted('0.4.0-dev.481', 'abc123');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('core started 0.4.0-dev.481', {
      level: 'info',
      tags: { version: '0.4.0-dev.481', commit: 'abc123' },
    });
  });

  it('names an unknown commit when the build carries none', () => {
    const captureMessage = vi.fn();
    provideErrorTracker({
      captureException: vi.fn(),
      captureMessage,
      addBreadcrumb: vi.fn(),
      flush: vi.fn(async () => true),
    });
    reportStarted('1.0.0', null);
    expect(captureMessage.mock.calls[0]?.[1]).toMatchObject({ tags: { commit: 'unknown' } });
  });
});
