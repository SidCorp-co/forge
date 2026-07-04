import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexMemoryMock = vi.fn();
vi.mock('./indexer.js', () => ({
  MAX_EMBED_CHARS: 8192,
  indexMemory: (input: unknown, opts: unknown) => indexMemoryMock(input, opts),
}));

const { MemoryWriteValidationError, runMemoryWrite, writeMemoryInputSchema } = await import(
  './write-service.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  indexMemoryMock.mockReset();
});

describe('writeMemoryInputSchema', () => {
  it('accepts a minimal valid payload', () => {
    const r = writeMemoryInputSchema.safeParse({
      projectId: PROJECT_ID,
      source: 'note',
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
      source: 'note',
      sourceRef: 'run:1/step:plan/attempt:1',
      textContent: 'handoff text',
      metadata: { run_id: 'run-1', step: 'plan', attempt: 1 },
    });

    expect(r).toBe(fakeResult);
    expect(indexMemoryMock).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'run:1/step:plan/attempt:1',
        text: 'handoff text',
        metadata: { run_id: 'run-1', step: 'plan', attempt: 1 },
      },
      { semanticDedup: true },
    );
  });

  it('enables semantic dedup only for agent-curated sources', async () => {
    indexMemoryMock.mockResolvedValue({
      id: 'm-3',
      embeddedAt: new Date(),
      truncated: false,
      degraded: false,
    });

    await runMemoryWrite({
      projectId: PROJECT_ID,
      source: 'knowledge',
      sourceRef: 'k-1',
      textContent: 'a convention',
    });
    expect(indexMemoryMock).toHaveBeenLastCalledWith(expect.anything(), { semanticDedup: true });

    await runMemoryWrite({
      projectId: PROJECT_ID,
      source: 'decision',
      sourceRef: 'd-1',
      textContent: 'a pm decision mirror',
    });
    expect(indexMemoryMock).toHaveBeenLastCalledWith(expect.anything(), { semanticDedup: false });
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

  it('rejects agent-authored text over the embedding window (8192)', async () => {
    await expect(
      runMemoryWrite({
        projectId: PROJECT_ID,
        source: 'knowledge',
        sourceRef: 'k-big',
        textContent: 'x'.repeat(8193),
      }),
    ).rejects.toThrow(MemoryWriteValidationError);
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('allows long text on lifecycle-mirror sources (issue mirrors store verbatim)', async () => {
    indexMemoryMock.mockResolvedValueOnce({
      id: 'm-issue',
      embeddedAt: new Date(),
      truncated: true,
      degraded: false,
    });
    await expect(
      runMemoryWrite({
        projectId: PROJECT_ID,
        source: 'issue',
        sourceRef: 'iss-1',
        textContent: 'x'.repeat(20_000),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a fenced code block longer than 5 lines in agent-authored memory', async () => {
    const block = ['```ts', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```'].join('\n');
    await expect(
      runMemoryWrite({
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'n-code',
        textContent: `context\n${block}\nmore`,
      }),
    ).rejects.toThrow(/fenced code block/);
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('counts an unterminated fence to the end of the text', async () => {
    const text = ['intro', '```', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n');
    await expect(
      runMemoryWrite({
        projectId: PROJECT_ID,
        source: 'policy',
        sourceRef: 'p-code',
        textContent: text,
      }),
    ).rejects.toThrow(MemoryWriteValidationError);
  });

  it('allows short fenced one-liners (verify commands) and inline code', async () => {
    indexMemoryMock.mockResolvedValueOnce({
      id: 'm-ok',
      embeddedAt: new Date(),
      truncated: false,
      degraded: false,
    });
    const text = [
      'invariant: cascade routes through `cascadeCancelChildJobs` (runs-cascade.ts:12)',
      '```sql',
      "SELECT status FROM issues WHERE id='x';",
      '```',
    ].join('\n');
    await expect(
      runMemoryWrite({
        projectId: PROJECT_ID,
        source: 'knowledge',
        sourceRef: 'k-ok',
        textContent: text,
      }),
    ).resolves.toBeDefined();
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
