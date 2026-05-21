import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => {
  const execute = vi.fn(async () => []);
  const update = vi.fn();
  return { db: { execute, update } };
});

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { db } = await import('../db/client.js');
const { logger } = await import('../logger.js');
const { persistPromptSnapshot } = await import('./prompt-snapshot.js');

type AnyMock = ReturnType<typeof vi.fn>;

function captureUpdateSet(): AnyMock {
  const setSpy = vi.fn(() => ({ where: async () => undefined }));
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).update.mockImplementation(() => ({ set: setSpy }));
  return setSpy;
}

describe('persistPromptSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    (db as any).execute.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('UPSERTs prompt_blobs with sha256(systemPrompt) hash and updates jobs row', async () => {
    const setSpy = captureUpdateSet();
    const systemPrompt = 'pipeline rules + tools + project config';
    const expectedHash = crypto.createHash('sha256').update(systemPrompt).digest('hex');

    await persistPromptSnapshot({
      jobId: 'job-1',
      systemPrompt,
      userPrompt: '/forge-plan iss-1',
      blocks: [
        { id: 'pipeline-rules', kind: 'system', chars: 10, estTokens: 3 },
        { id: 'tool-reference', kind: 'system', chars: 20, estTokens: 6 },
      ],
      model: 'sonnet',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).execute).toHaveBeenCalledTimes(1);
    // The Drizzle `sql` template is passed as a tagged-template object; we
    // verify by reading the joined SQL the helper produced.
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    const callArg = (db as any).execute.mock.calls[0][0];
    const joined = (callArg.queryChunks ?? [])
      .map((c: unknown) => (typeof c === 'object' && c && 'value' in c ? (c as { value: string }).value : ''))
      .join('');
    expect(joined).toMatch(/INSERT INTO prompt_blobs/);
    expect(joined).toMatch(/ON CONFLICT \(hash\) DO UPDATE SET ref_count = prompt_blobs.ref_count \+ 1/);
    // The hash is the first parameter; assert it via the queryChunks.params side.
    expect(JSON.stringify(callArg)).toContain(expectedHash);

    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0][0];
    expect(setArg).toMatchObject({
      systemPromptHash: expectedHash,
      userPromptSnapshot: '/forge-plan iss-1',
      modelUsed: 'sonnet',
    });
    expect(setArg.promptInputTokenEst).toBeGreaterThan(0);
    expect(Array.isArray(setArg.promptBlocks)).toBe(true);
    expect(setArg.promptBlocks).toHaveLength(2);
  });

  it('forwards `model` arg verbatim into modelUsed (no remapping)', async () => {
    const setSpy = captureUpdateSet();
    await persistPromptSnapshot({
      jobId: 'job-2',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      blocks: [],
      model: 'claude-opus-4-7',
    });
    expect(setSpy.mock.calls[0][0]).toMatchObject({ modelUsed: 'claude-opus-4-7' });
  });

  it('swallows db errors and logs a warning (does not throw)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    (db as any).execute.mockRejectedValueOnce(new Error('boom'));

    await expect(
      persistPromptSnapshot({
        jobId: 'job-3',
        systemPrompt: 'sys',
        userPrompt: '',
        blocks: [],
        model: 'default',
      }),
    ).resolves.toBeUndefined();

    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((logger as any).warn).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    const [ctx, msg] = (logger as any).warn.mock.calls[0];
    expect(ctx).toMatchObject({ jobId: 'job-3' });
    expect(String(msg)).toMatch(/prompt-snapshot/);
  });

  it('produces a stable hash for identical system prompts', async () => {
    const setSpy = captureUpdateSet();
    const systemPrompt = 'same-content';

    await persistPromptSnapshot({
      jobId: 'a',
      systemPrompt,
      userPrompt: '',
      blocks: [],
      model: 'default',
    });
    await persistPromptSnapshot({
      jobId: 'b',
      systemPrompt,
      userPrompt: '',
      blocks: [],
      model: 'default',
    });

    const hashA = setSpy.mock.calls[0][0].systemPromptHash;
    const hashB = setSpy.mock.calls[1][0].systemPromptHash;
    expect(hashA).toBe(hashB);
  });
});
