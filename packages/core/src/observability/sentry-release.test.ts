import { afterEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
vi.mock('@sentry/node', () => ({ init }));

const initWith = async (commit: string | undefined): Promise<Record<string, unknown>> => {
  if (commit === undefined) delete process.env.SOURCE_COMMIT;
  else process.env.SOURCE_COMMIT = commit;
  process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.example.com/0';
  init.mockClear();
  vi.resetModules();
  const { initSentry } = await import('./sentry.js');
  expect(initSentry()).toBe(true);
  expect(init).toHaveBeenCalledTimes(1);
  return init.mock.calls[0]?.[0] as Record<string, unknown>;
};

describe('core Sentry release', () => {
  afterEach(() => {
    delete process.env.SOURCE_COMMIT;
    delete process.env.SENTRY_DSN;
  });

  it('is the commit the build was made from, and nothing else', async () => {
    const opts = await initWith('3dee4d1f24ed2733f22065ab3f7caf921585a904');
    expect(opts.release).toBe('3dee4d1f24ed2733f22065ab3f7caf921585a904');
  });

  it('attaches no release when the build was not told its commit', async () => {
    const opts = await initWith(undefined);
    expect(opts.release).toBeUndefined();
    expect(String(opts.release ?? '')).not.toContain('0.3.0');
  });

  it('keeps the privacy contract: no tracing, no PII, scrubbed before send', async () => {
    const opts = await initWith('3dee4d1f24ed2733f22065ab3f7caf921585a904');
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.beforeSend).toBe('function');
  });

  it('never attaches at all without a DSN', async () => {
    delete process.env.SENTRY_DSN;
    init.mockClear();
    vi.resetModules();
    const { initSentry } = await import('./sentry.js');
    expect(initSentry()).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });
});
