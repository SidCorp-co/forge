import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { error: loggerError },
}));

const { HooksBus } = await import('./hooks.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function basePayload() {
  return {
    issueId: ISSUE_ID,
    projectId: PROJECT_ID,
    actor: { type: 'user' as const, id: USER_ID },
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

  it('isolates throwing subscribers: logs error and continues', async () => {
    const bus = new HooksBus();
    const good = vi.fn();
    bus.on('commentCreated', () => {
      throw new Error('boom');
    });
    bus.on('commentCreated', good);

    await expect(bus.emit('commentCreated', basePayload())).resolves.toBeUndefined();

    expect(good).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]?.[0]).toMatchObject({ topic: 'commentCreated' });
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
    await expect(bus.emit('commentCreated', basePayload())).resolves.toBeUndefined();
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
