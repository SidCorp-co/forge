import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.fn();

class FakeEmbeddingUnavailableError extends Error {}

vi.mock('../embeddings/index.js', () => ({
  embed: (text: string) => embedMock(text),
  EmbeddingUnavailableError: FakeEmbeddingUnavailableError,
}));

const warnMock = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Chainable stub for db.insert(...).values(...).onConflictDoUpdate(...).returning(...)
const valuesMock = vi.fn();
const conflictMock = vi.fn();
const returningMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        valuesMock(v);
        return {
          onConflictDoUpdate: (cfg: unknown) => {
            conflictMock(cfg);
            return { returning: () => returningMock() };
          },
        };
      },
    }),
  },
}));

const { indexMemory, indexMemoryBestEffort } = await import('./indexer.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  embedMock.mockReset();
  valuesMock.mockReset();
  conflictMock.mockReset();
  returningMock.mockReset();
  warnMock.mockReset();
  embedMock.mockResolvedValue([0.1, 0.2]);
  returningMock.mockResolvedValue([{ id: 'm-1', embeddedAt: new Date() }]);
});

describe('indexMemory', () => {
  it('stores the full text but embeds only the first 8192 chars', async () => {
    const longText = 'x'.repeat(10_000);
    const result = await indexMemory({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-1',
      text: longText,
    });

    expect(result.truncated).toBe(true);
    expect(result.degraded).toBe(false);
    expect(embedMock).toHaveBeenCalledWith('x'.repeat(8192));
    const stored = valuesMock.mock.calls[0]?.[0] as { textContent: string };
    expect(stored.textContent).toHaveLength(10_000);
  });

  it('does not flag truncation for short text', async () => {
    const result = await indexMemory({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-2',
      text: 'short',
    });
    expect(result.truncated).toBe(false);
    expect(embedMock).toHaveBeenCalledWith('short');
  });

  it('stores a degraded row (embedding null) when embeddings are unavailable', async () => {
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('service down'));
    const result = await indexMemory({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-3',
      text: 'survives the outage',
    });

    expect(result.degraded).toBe(true);
    const stored = valuesMock.mock.calls[0]?.[0] as { embedding: number[] | null };
    expect(stored.embedding).toBeNull();
    // embeddedAt must NOT advance on the conflict path for degraded writes.
    const conflictSet = (conflictMock.mock.calls[0]?.[0] as { set: Record<string, unknown> }).set;
    expect('embeddedAt' in conflictSet).toBe(false);
  });

  it('rethrows non-outage embed errors', async () => {
    embedMock.mockRejectedValueOnce(new Error('dimension mismatch'));
    await expect(
      indexMemory({ projectId: PROJECT_ID, source: 'note', sourceRef: 'n-4', text: 't' }),
    ).rejects.toThrow('dimension mismatch');
  });
});

describe('indexMemoryBestEffort', () => {
  it('swallows DB failures with a warn log', async () => {
    returningMock.mockRejectedValueOnce(new Error('connection refused'));
    await indexMemoryBestEffort({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-5',
      text: 't',
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: 'n-5' }),
      'memory.indexer: write failed',
    );
  });
});
