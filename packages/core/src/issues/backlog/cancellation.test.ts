import { describe, expect, it, vi } from 'vitest';
import { Cancellation, startBudget } from './cancellation.js';

describe('Cancellation', () => {
  it('starts uncancelled with no reason', () => {
    const c = new Cancellation();
    expect(c.cancelled).toBe(false);
    expect(c.reason).toBeNull();
  });

  it('keeps the first cause, so a shutdown behind a disconnect does not rewrite it', () => {
    const c = new Cancellation();
    c.cancel('disconnect');
    c.cancel('shutdown');
    expect(c.reason).toBe('disconnect');
  });

  it('runs a listener registered before the trip', () => {
    const c = new Cancellation();
    const seen: string[] = [];
    c.onCancel((cause) => seen.push(cause));
    c.cancel('budget');
    expect(seen).toEqual(['budget']);
  });

  it('runs a listener registered after the trip, at once', () => {
    const c = new Cancellation();
    c.cancel('shutdown');
    const seen: string[] = [];
    c.onCancel((cause) => seen.push(cause));
    expect(seen).toEqual(['shutdown']);
  });

  it('runs each listener once and no more', () => {
    const c = new Cancellation();
    const listener = vi.fn();
    c.onCancel(listener);
    c.cancel('budget');
    c.cancel('budget');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('startBudget', () => {
  it('trips with budget once the time is up', () => {
    vi.useFakeTimers();
    const c = new Cancellation();
    startBudget(c, 1_000);
    expect(c.cancelled).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(c.reason).toBe('budget');
    vi.useRealTimers();
  });

  it('does not trip once its timer is cleared', () => {
    vi.useFakeTimers();
    const c = new Cancellation();
    startBudget(c, 1_000)();
    vi.advanceTimersByTime(10_000);
    expect(c.cancelled).toBe(false);
    vi.useRealTimers();
  });
});
