import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provideErrorTracker } from './lib/error-tracking.js';

/** A loopback port nothing listens on, so the migrate connection is refused at once. */
async function refusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe('the migrate entry, when it cannot migrate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the failure through the error-tracking port and flushes it before exiting 1', async () => {
    const seen: string[] = [];
    const reports: { message: string; context: Record<string, unknown> }[] = [];
    provideErrorTracker({
      captureException: () => {
        seen.push('exception');
      },
      captureMessage: (message, context) => {
        seen.push('report');
        reports.push({ message, context: context as Record<string, unknown> });
      },
      addBreadcrumb: () => {},
      flush: async () => {
        seen.push('flush');
        return true;
      },
    });
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        seen.push(`exit ${code}`);
        resolve(code);
        return undefined as never;
      }) as typeof process.exit);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.DATABASE_URL = `postgres://forge:forge@127.0.0.1:${await refusedPort()}/forge`;

    await import('./migrate.js');

    expect(await exited, 'a boot that cannot migrate must exit non-zero').toBe(1);
    expect(
      seen,
      'the failure is reported, then flushed, then the process exits — stdout alone is not a record',
    ).toEqual(['report', 'flush', 'exit 1']);
    const [report] = reports;
    expect(report?.message).toMatch(/^db\.migrate: boot migration failed while reading-recorded/);
    expect(report?.context).toMatchObject({
      level: 'fatal',
      tags: { area: 'db-migrate', stage: 'reading-recorded' },
      extra: { journal: expect.any(Number), recorded: null, migration: null },
    });
    expect(JSON.stringify(report), 'the DB URL never leaves in a report').not.toContain(
      'forge:forge@',
    );
  });
});
