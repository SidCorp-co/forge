import { beforeEach, describe, expect, it, vi } from 'vitest';

const needingMock = vi.fn();
const indexMock = vi.fn();
vi.mock('../conversations/transcript-index.js', () => ({
  conversationsNeedingIndex: (...a: unknown[]) => needingMock(...a),
  indexConversationOnce: (...a: unknown[]) => indexMock(...a),
}));
const errorMock = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => errorMock(...a) },
}));
const createQueue = vi.fn(async () => {});
const work = vi.fn(async (_q: string, _h: () => Promise<void>) => 'worker-1');
const schedule = vi.fn(async () => {});
vi.mock('../queue/boss.js', () => ({ boss: { createQueue, work, schedule } }));

const {
  _resetTranscriptIndexSweeperForTest,
  registerTranscriptIndexSweeper,
  runTranscriptIndexSweepOnce,
  TRANSCRIPT_INDEX_ROOMS_PER_TICK,
} = await import('./conversation-index-drain.js');

beforeEach(() => {
  needingMock.mockReset();
  indexMock.mockReset();
  errorMock.mockReset();
  createQueue.mockClear();
  work.mockClear();
  schedule.mockClear();
  _resetTranscriptIndexSweeperForTest();
});

describe('runTranscriptIndexSweepOnce', () => {
  it('indexes every room the transcript has moved past, within the tick budget', async () => {
    needingMock.mockResolvedValue(['a', 'b']);
    indexMock.mockResolvedValue({ outcome: 'indexed' });
    await expect(runTranscriptIndexSweepOnce()).resolves.toEqual(['a', 'b']);
    expect(needingMock).toHaveBeenCalledWith(TRANSCRIPT_INDEX_ROOMS_PER_TICK);
    expect(indexMock).toHaveBeenCalledTimes(2);
  });

  it('asks for rooms by what the tables say, never by a flag a writer sets', async () => {
    // The selection is `conversationsNeedingIndex`, which compares the transcript's own
    // maximum against the state row; a missed flag would be a room never indexed again.
    needingMock.mockResolvedValue([]);
    await runTranscriptIndexSweepOnce();
    expect(indexMock).not.toHaveBeenCalled();
  });

  it('keeps going after a room throws, and logs the room that failed', async () => {
    needingMock.mockResolvedValue(['bad', 'good']);
    indexMock.mockRejectedValueOnce(new Error('open passage covers too much'));
    indexMock.mockResolvedValueOnce({ outcome: 'indexed' });
    await expect(runTranscriptIndexSweepOnce()).resolves.toEqual(['good']);
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'bad' }),
      expect.stringContaining('room failed'),
    );
  });

  it('does not count a room that vanished mid-tick as advanced', async () => {
    needingMock.mockResolvedValue(['gone']);
    indexMock.mockResolvedValue({ outcome: 'conversation-gone' });
    await expect(runTranscriptIndexSweepOnce()).resolves.toEqual([]);
    expect(errorMock).not.toHaveBeenCalled();
  });
});

describe('registerTranscriptIndexSweeper', () => {
  it('creates, works and schedules the queue exactly once', async () => {
    await registerTranscriptIndexSweeper();
    await registerTranscriptIndexSweeper();
    expect(createQueue).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith('conversations.transcript-index', '* * * * *', {});
  });

  it('rethrows a tick failure so pg-boss records the job as failed', async () => {
    needingMock.mockRejectedValue(new Error('db down'));
    await registerTranscriptIndexSweeper();
    const handler = work.mock.calls[0]?.[1] as unknown as () => Promise<void>;
    await expect(handler()).rejects.toThrow('db down');
    expect(errorMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('tick failed'),
    );
  });
});
