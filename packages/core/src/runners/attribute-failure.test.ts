import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { isBoxAttributable, summarizeRunnerError } = await import('./attribute-failure.js');

describe('isBoxAttributable', () => {
  // cm:guard the pixelight failure text verbatim — three boxes emitted this for three days while lastError stayed null
  it('recognises the runner preflight prefix', () => {
    expect(
      isBoxAttributable(
        'preflight_failed: push_credentials: git@github.com: Permission denied (publickey).',
      ),
    ).toBe(true);
  });

  it('recognises any preflight check, not just push_credentials', () => {
    expect(isBoxAttributable('preflight_failed: work_tree: dirty checkout')).toBe(true);
    expect(isBoxAttributable('preflight_failed: hooks_path: dangling core.hooksPath')).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(isBoxAttributable('  preflight_failed: work_tree: x')).toBe(true);
  });

  // cm:guard the whole point is that this is BOX-scoped. Attributing an agent's or the model provider's failure to the box would put a red badge on a healthy machine and send the operator to the wrong place.
  it.each([
    ['[RESULT_ERROR] success: You have hit your org monthly spend limit', 'provider quota'],
    ['job_failed', 'generic job failure'],
    ['Agent completed with errors', 'agent-side'],
    ['pipeline_cancelled', 'cascade'],
    ['a log line mentioning preflight_failed: later on', 'not at the start'],
  ])('does not attribute %s (%s)', (error) => {
    expect(isBoxAttributable(error)).toBe(false);
  });

  it.each([[null], [undefined], ['']])('handles %s without throwing', (error) => {
    expect(isBoxAttributable(error as string | null | undefined)).toBe(false);
  });
});

describe('summarizeRunnerError', () => {
  it('keeps a normal message intact and trimmed', () => {
    expect(summarizeRunnerError('  preflight_failed: work_tree: dirty  ')).toBe(
      'preflight_failed: work_tree: dirty',
    );
  });

  it('caps a runaway message at the column width', () => {
    const out = summarizeRunnerError(`preflight_failed: ${'x'.repeat(2000)}`);
    expect(out.length).toBe(500);
    expect(out.startsWith('preflight_failed:')).toBe(true);
  });
});
