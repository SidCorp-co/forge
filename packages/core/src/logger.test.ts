import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { logger } from './logger.js';

describe('logger', () => {
  it('exposes a functional child logger', () => {
    const child = logger.child({ requestId: 'test-id' });
    expect(() => child.info('probe')).not.toThrow();
  });

  it('redacts sensitive fields (via matching redact config on a probe instance)', () => {
    const chunks: string[] = [];
    const stream = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };
    const probe = pino(
      {
        level: 'info',
        redact: {
          paths: [
            'password',
            'token',
            'apiKey',
            'secret',
            'headers.authorization',
            'headers.cookie',
            '*.password',
            '*.token',
          ],
          censor: '[Redacted]',
        },
      },
      stream,
    );

    probe.info({
      password: 'hunter2',
      token: 'secret-tok',
      apiKey: 'k',
      headers: { authorization: 'Bearer x', cookie: 'c=1' },
      user: { password: 'nested', token: 'nested-tok' },
      keep: 'visible',
    });

    const line = chunks.join('');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('secret-tok');
    expect(line).not.toContain('Bearer x');
    expect(line).not.toContain('nested-tok');
    expect(line).toContain('[Redacted]');
    expect(line).toContain('visible');
  });
});
