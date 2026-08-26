import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));
vi.mock('../db/client.js', () => ({ db: { update } }));

const { NO_ACK_ERROR, attributeFailureToRunner, classifyBoxFault } = await import(
  './attribute-failure.js'
);

const RUNNER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  updateWhere.mockReset();
  updateWhere.mockResolvedValue(undefined);
  updateSet.mockClear();
  update.mockClear();
});

describe('classifyBoxFault', () => {
  // cm:guard the pixelight failure text verbatim — three boxes emitted this for three days while lastError stayed null
  it('keys a preflight failure on its check, not on the whole message', () => {
    expect(
      classifyBoxFault(
        'preflight_failed: push_credentials: git@github.com: Permission denied (publickey).',
      ),
    ).toEqual({
      key: 'preflight_failed: push_credentials',
      summary: 'preflight_failed: push_credentials: git@github.com: Permission denied (publickey).',
    });
  });

  it('recognises any preflight check, not just push_credentials', () => {
    expect(classifyBoxFault('preflight_failed: work_tree: dirty checkout')?.key).toBe(
      'preflight_failed: work_tree',
    );
    expect(classifyBoxFault('preflight_failed: hooks_path: dangling core.hooksPath')?.key).toBe(
      'preflight_failed: hooks_path',
    );
  });

  it('tolerates whitespace around the prefix and the token', () => {
    expect(classifyBoxFault('  preflight_failed:  work_tree : dirty  ')?.key).toBe(
      'preflight_failed: work_tree',
    );
  });

  it('caps the summary at the column width', () => {
    const fault = classifyBoxFault(`preflight_failed: work_tree: ${'x'.repeat(2000)}`);
    expect(fault?.summary.length).toBe(500);
    expect(fault?.key).toBe('preflight_failed: work_tree');
  });

  // cm:why the class the fleet was blind to (ISS-862): a box that takes the dispatch and never starts it
  it('recognises a never-claimed dispatch and gives it a readable summary', () => {
    const fault = classifyBoxFault(NO_ACK_ERROR);
    expect(fault?.key).toBe(NO_ACK_ERROR);
    expect(fault?.summary).toContain('never claimed');
  });

  it('gives a no-ack and a preflight failure DIFFERENT keys, so neither extends the other', () => {
    expect(classifyBoxFault(NO_ACK_ERROR)?.key).not.toBe(
      classifyBoxFault('preflight_failed: work_tree: x')?.key,
    );
  });

  // cm:guard the whole point is that this is BOX-scoped. Attributing an agent's or the model provider's failure to the box would put a red badge on a healthy machine and send the operator to the wrong place.
  it.each([
    ['[RESULT_ERROR] success: You have hit your org monthly spend limit', 'provider quota'],
    ['job_failed', 'generic job failure'],
    ['Agent completed with errors', 'agent-side'],
    ['pipeline_cancelled', 'cascade'],
    ['a log line mentioning preflight_failed: later on', 'not at the start'],
    ['session_lost', 'an agent session that started and then died'],
    ['dispatch_unclaimed: something else', 'a longer message that merely starts with the token'],
  ])('does not classify %s (%s)', (error) => {
    expect(classifyBoxFault(error)).toBeNull();
  });

  it.each([[null], [undefined], ['']])('handles %s without throwing', (error) => {
    expect(classifyBoxFault(error as string | null | undefined)).toBeNull();
  });

  it('returns null when the preflight prefix carries no check token', () => {
    expect(classifyBoxFault('preflight_failed:')).toBeNull();
    expect(classifyBoxFault('preflight_failed:   ')).toBeNull();
  });
});

describe('attributeFailureToRunner', () => {
  it('stamps lastError for a preflight failure', async () => {
    expect(
      await attributeFailureToRunner(RUNNER_A, 'preflight_failed: work_tree: dirty checkout'),
    ).toBe(true);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'preflight_failed: work_tree: dirty checkout' }),
    );
  });

  // cm:why the measured complaint: lastError read null on a box that had failed 10 dispatches running
  it('stamps lastError for a never-claimed dispatch', async () => {
    expect(await attributeFailureToRunner(RUNNER_A, NO_ACK_ERROR)).toBe(true);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: expect.stringContaining('never claimed') }),
    );
  });

  it('writes nothing for a failure the box does not own', async () => {
    expect(await attributeFailureToRunner(RUNNER_A, 'session_lost')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes nothing when the job has no runner', async () => {
    expect(await attributeFailureToRunner(null, NO_ACK_ERROR)).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('never throws when the DB update fails (best-effort contract)', async () => {
    updateWhere.mockRejectedValueOnce(new Error('db down'));
    await expect(attributeFailureToRunner(RUNNER_A, NO_ACK_ERROR)).resolves.toBe(false);
  });
});
