import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { error: loggerError },
}));

const { HooksBus, assertHookDelivered, HookDeliveryError } = await import('./hooks.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function basePayload() {
  return {
    issueId: ISSUE_ID,
    projectId: PROJECT_ID,
    actor: { type: 'user' as const, id: USER_ID, agency: 'human' as const },
    commentId: '44444444-4444-4444-8444-444444444444',
    body: 'hi',
  };
}

beforeEach(() => {
  loggerError.mockReset();
});

describe('HooksBus', () => {
  it('invokes subscribed handler with exact payload', async () => {
    const bus = new HooksBus();
    const handler = vi.fn();
    bus.on('commentCreated', handler);

    const payload = basePayload();
    await bus.emit('commentCreated', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('fires multiple subscribers in registration order', async () => {
    const bus = new HooksBus();
    const order: number[] = [];
    bus.on('commentCreated', () => {
      order.push(1);
    });
    bus.on('commentCreated', async () => {
      await Promise.resolve();
      order.push(2);
    });
    bus.on('commentCreated', () => {
      order.push(3);
    });

    await bus.emit('commentCreated', basePayload());

    expect(order).toEqual([1, 2, 3]);
  });

  it('isolates throwing subscribers: logs error, continues, and reports the failure', async () => {
    const bus = new HooksBus();
    const good = vi.fn();
    bus.on('commentCreated', () => {
      throw new Error('boom');
    });
    bus.on('commentCreated', good);

    const result = await bus.emit('commentCreated', basePayload());

    expect(good).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]?.[0]).toMatchObject({ topic: 'commentCreated' });
    expect(result.delivered).toBe(2);
    expect(result.failures).toHaveLength(1);
  });

  it('records one failures entry per throwing subscriber, in registration order, and still invokes later subscribers', async () => {
    const bus = new HooksBus();
    const order: string[] = [];
    bus.on(
      'commentCreated',
      () => {
        order.push('a');
        throw new Error('a failed');
      },
      { name: 'a' },
    );
    bus.on(
      'commentCreated',
      () => {
        order.push('b');
      },
      { name: 'b' },
    );
    bus.on(
      'commentCreated',
      () => {
        order.push('c');
        throw new Error('c failed');
      },
      { name: 'c' },
    );

    const result = await bus.emit('commentCreated', basePayload());

    expect(order).toEqual(['a', 'b', 'c']);
    expect(result.delivered).toBe(3);
    expect(result.failures.map((f) => f.subscriber)).toEqual(['a', 'c']);
  });

  it('uses the opts.name passed to on() as the failures[].subscriber', async () => {
    const bus = new HooksBus();
    bus.on(
      'commentCreated',
      () => {
        throw new Error('boom');
      },
      { name: 'my-subscriber' },
    );

    const result = await bus.emit('commentCreated', basePayload());

    expect(result.failures[0]?.subscriber).toBe('my-subscriber');
  });

  it('resolves (never rejects) when every subscriber throws', async () => {
    const bus = new HooksBus();
    bus.on('commentCreated', () => {
      throw new Error('one');
    });
    bus.on('commentCreated', () => {
      throw new Error('two');
    });

    const result = await bus.emit('commentCreated', basePayload());

    expect(result.delivered).toBe(2);
    expect(result.failures.map((f) => (f.error as Error).message)).toEqual(['one', 'two']);
  });

  it('awaits async subscribers before returning', async () => {
    const bus = new HooksBus();
    let resolved = false;
    bus.on('commentCreated', async () => {
      await new Promise<void>((r) => setTimeout(r, 5));
      resolved = true;
    });

    await bus.emit('commentCreated', basePayload());

    expect(resolved).toBe(true);
  });

  it('unsubscribe fn removes the handler', async () => {
    const bus = new HooksBus();
    const handler = vi.fn();
    const off = bus.on('commentCreated', handler);
    off();

    await bus.emit('commentCreated', basePayload());

    expect(handler).not.toHaveBeenCalled();
  });

  it('emit is a no-op when no handlers are registered', async () => {
    const bus = new HooksBus();
    await expect(bus.emit('commentCreated', basePayload())).resolves.toEqual({
      topic: 'commentCreated',
      delivered: 0,
      failures: [],
    });
  });

  it('reset() clears all handlers', async () => {
    const bus = new HooksBus();
    const handler = vi.fn();
    bus.on('commentCreated', handler);
    bus.reset();

    await bus.emit('commentCreated', basePayload());

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('assertHookDelivered', () => {
  it('is a no-op when failures is empty', () => {
    expect(() =>
      assertHookDelivered({ topic: 'commentCreated', delivered: 2, failures: [] }),
    ).not.toThrow();
  });

  it('throws HookDeliveryError naming the failed subscribers', () => {
    const result = {
      topic: 'commentCreated' as const,
      delivered: 2,
      failures: [
        { subscriber: 'a', error: new Error('a failed') },
        { subscriber: 'b', error: new Error('b failed') },
      ],
    };

    expect(() => assertHookDelivered(result)).toThrow(HookDeliveryError);
    try {
      assertHookDelivered(result);
      throw new Error('expected assertHookDelivered to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HookDeliveryError);
      expect(
        (err as InstanceType<typeof HookDeliveryError>).failures.map((f) => f.subscriber),
      ).toEqual(['a', 'b']);
      expect((err as Error).message).toContain('a failed');
      expect((err as Error).message).toContain('b failed');
    }
  });

  it('scopes escalation to opts.owned, ignoring failures from other subscribers', () => {
    const result = {
      topic: 'transition' as const,
      delivered: 2,
      failures: [{ subscriber: 'pm', error: new Error('pm failed') }],
    };

    expect(() => assertHookDelivered(result, { owned: ['pipeline-orchestrator'] })).not.toThrow();
  });
});
