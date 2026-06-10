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
const returningMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        valuesMock(v);
        return {
          onConflictDoUpdate: () => ({
            returning: () => returningMock(),
          }),
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
});

describe('indexMemoryBestEffort', () => {
  it('classifies EmbeddingUnavailableError as an embed failure', async () => {
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('service down'));
    await indexMemoryBestEffort({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-3',
      text: 't',
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: 'n-3' }),
      'memory.indexer: embed failed, skipping',
    );
  });

  it('classifies other errors as upsert failures even when the message mentions embed', async () => {
    returningMock.mockRejectedValueOnce(new Error('column embedding violates constraint'));
    await indexMemoryBestEffort({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'n-4',
      text: 't',
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: 'n-4' }),
      'memory.indexer: upsert failed',
    );
  });
});
