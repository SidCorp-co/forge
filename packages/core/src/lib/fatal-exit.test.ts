// A throw nothing caught ends the process with a non-zero code, after one fatal line in our own log
// naming what it was: never a process left running in a state nobody reasoned about, never an exit
// whose only trace is Node's stack on stderr. The handlers are called as Node calls them, with an
// exit that is recorded rather than taken.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ fatal: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { fatal: logged.fatal } }));

const { installFatalExit } = await import('./fatal-exit.js');

type Handler = (reason: unknown) => void;
let added: { event: 'uncaughtException' | 'unhandledRejection'; fn: Handler }[] = [];
let exit: ReturnType<typeof vi.fn>;

/** Installs the fatal exit and hands back the two listeners it added to the process. */
function install(): Record<'uncaughtException' | 'unhandledRejection', Handler> {
  const before = {
    uncaughtException: new Set(process.listeners('uncaughtException')),
    unhandledRejection: new Set(process.listeners('unhandledRejection')),
  };
  installFatalExit(exit as unknown as (code: number) => void);
  const pick = (event: 'uncaughtException' | 'unhandledRejection') => {
    const fn = (process.listeners(event) as unknown as Handler[]).find(
      (l) => !before[event].has(l as never),
    );
    if (!fn) throw new Error(`installFatalExit added no ${event} listener`);
    added.push({ event, fn });
    return fn;
  };
  return {
    uncaughtException: pick('uncaughtException'),
    unhandledRejection: pick('unhandledRejection'),
  };
}

beforeEach(() => {
  logged.fatal.mockClear();
  exit = vi.fn();
});

afterEach(() => {
  for (const { event, fn } of added) process.off(event, fn as never);
  added = [];
});

const exited = () => vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

describe('the fatal exit', () => {
  it('logs an unhandled rejection as one fatal line, then exits 1', async () => {
    install().unhandledRejection(new Error('planted rejection'));
    await exited();
    expect(logged.fatal).toHaveBeenCalledTimes(1);
    const [fields, msg] = logged.fatal.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('@forge/core unhandledRejection, exiting: planted rejection');
    expect(fields).toMatchObject({ kind: 'unhandledRejection', queue: null, worker: null });
  });

  it('logs an uncaught exception the same way', async () => {
    install().uncaughtException(new Error('planted exception'));
    await exited();
    expect(logged.fatal.mock.calls[0]?.[1]).toBe(
      '@forge/core uncaughtException, exiting: planted exception',
    );
  });

  it("names the queue and worker of an `error` event nobody listened for, as pg-boss's was", async () => {
    let thrown: unknown;
    try {
      new EventEmitter().emit('error', {
        message: 'planted fetch failure',
        queue: 'outbox.q',
        worker: 'w-9',
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe('ERR_UNHANDLED_ERROR');
    install().unhandledRejection(thrown);
    await exited();
    const [fields, msg] = logged.fatal.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ queue: 'outbox.q', worker: 'w-9' });
    expect(msg).toContain('planted fetch failure');
  });

  it('logs the first of two fatals only, and exits once', async () => {
    const h = install();
    h.unhandledRejection(new Error('first'));
    h.uncaughtException(new Error('second'));
    await exited();
    expect(logged.fatal).toHaveBeenCalledTimes(1);
    expect(logged.fatal.mock.calls[0]?.[1]).toContain('first');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('names a rejection that is not an Error by its text', async () => {
    install().unhandledRejection('a bare string');
    await exited();
    expect(logged.fatal.mock.calls[0]?.[1]).toBe(
      '@forge/core unhandledRejection, exiting: a bare string',
    );
  });
});
