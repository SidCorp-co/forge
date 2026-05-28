import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexMemoryMock = vi.fn();
vi.mock('./indexer.js', () => ({
  indexMemory: (input: unknown) => indexMemoryMock(input),
}));

const { runMemoryWrite, writeMemoryInputSchema } = await import('./write-service.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  indexMemoryMock.mockReset();
});

describe('writeMemoryInputSchema', () => {
  it('accepts a minimal valid payload', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'step_handoff',
      sourceRef: 'run:1/step:plan/attempt:1',
      textContent: 'hello',
    });
    expect(r.success).toBe(true);
  });

  it('accepts free-form metadata object', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-1',
      textContent: 'x',
      metadata: { kind: 'note', attempt: 2, nested: { a: 1 } },
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty textContent (NOT NULL invariant)', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-1',
      textContent: '   ',
    });
    expect(r.success).toBe(false);
  });

  it('rejects textContent over 100KB', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-1',
      textContent: 'x'.repeat(100_001),
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown source value', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'made_up_source',
      sourceRef: 'r',
      textContent: 't',
    });
    expect(r.success).toBe(false);
  });

  it('rejects sourceRef over 512 chars', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'x'.repeat(513),
      textContent: 't',
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid projectId', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: 'not-a-uuid',
      source: 'note',
      sourceRef: 'r',
      textContent: 't',
    });
    expect(r.success).toBe(false);
  });
});

describe('runMemoryWrite', () => {
  it('forwards to indexMemory and returns its result', async () => {
    const fakeResult = { id: 'm-1', embeddedAt: new Date(), truncated: false };
    indexMemoryMock.mockResolvedValueOnce(fakeResult);

    const r = await runMemoryWrite({
      projectId: PROJECT_ID,
      source: 'step_handoff',
      sourceRef: 'run:1/step:plan/attempt:1',
      textContent: 'handoff text',
      metadata: { run_id: 'run-1', step: 'plan', attempt: 1 },
    });

    expect(r).toBe(fakeResult);
    expect(indexMemoryMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      source: 'step_handoff',
      sourceRef: 'run:1/step:plan/attempt:1',
      text: 'handoff text',
      metadata: { run_id: 'run-1', step: 'plan', attempt: 1 },
    });
  });

  it('omits metadata key entirely when input.metadata is undefined', async () => {
    indexMemoryMock.mockResolvedValueOnce({
      id: 'm-2',
      embeddedAt: new Date(),
      truncated: false,
    });

    await runMemoryWrite({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-1',
      textContent: 'no metadata',
    });

    const call = indexMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toBeDefined();
    expect('metadata' in call).toBe(false);
  });

  it('propagates indexer errors (strict mode)', async () => {
    indexMemoryMock.mockRejectedValueOnce(new Error('embed exploded'));
    await expect(
      runMemoryWrite({
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'n-1',
        textContent: 't',
      }),
    ).rejects.toThrow('embed exploded');
  });
});
