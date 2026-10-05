import { scrubSecretsDeep } from '@forge/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: string[] = [];

vi.mock('./session-events.js', () => ({
  recordTurnError: vi.fn(async (_id: string, error: string) => {
    recorded.push(error);
  }),
}));
vi.mock('./session-transcript.js', () => ({ deriveChatTurnFinal: vi.fn(async () => false) }));
vi.mock('../jobs/index.js', () => ({
  jobsOfSession: vi.fn(async () => ['job-1']),
  scrubJobOutput: vi.fn(async (_ids: readonly string[], data: unknown) =>
    scrubSecretsDeep(data, ['held-testing-secret-value']),
  ),
}));

const { applyTranscriptPatch } = await import('./patch-transcript.js');

const PAT = 'forge_pat_dev_0123456789abcdef0123456789abcdef';

describe('applyTranscriptPatch stores nothing a secret scrubber would remove', () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it("scrubs a device's turnError before it is recorded", async () => {
    await applyTranscriptPatch({
      sessionId: 's-1',
      isDevice: true,
      isTerminal: true,
      patch: {
        turnError: `curl failed: Authorization: Bearer ${PAT} and held-testing-secret-value`,
        toolCallCount: 1,
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).not.toContain(PAT);
    expect(recorded[0]).not.toContain('held-testing-secret-value');
  });

  it("scrubs a device's legacy messages before they are returned for storage", async () => {
    const out = await applyTranscriptPatch({
      sessionId: 's-1',
      isDevice: true,
      isTerminal: false,
      patch: {
        messages: [
          { role: 'assistant', content: `here is the token ${PAT}` },
          { role: 'user', content: 'and held-testing-secret-value' },
        ],
      },
    });
    const stored = JSON.stringify(out.messages);
    expect(stored).not.toContain(PAT);
    expect(stored).not.toContain('held-testing-secret-value');
    expect(out.messages).toHaveLength(2);
  });

  it('scrubs the title, metadata and diff a PATCH stores', async () => {
    const out = await applyTranscriptPatch({
      sessionId: 's-1',
      isDevice: true,
      isTerminal: false,
      patch: {
        title: `run with ${PAT}`,
        metadata: { note: 'held-testing-secret-value', token: 'abc', pendingSkillName: 'x' },
        diff: { patch: `+API_KEY=held-testing-secret-value\n+password=hunter2` },
      },
    });
    const stored = JSON.stringify(out.stored);
    expect(stored).not.toContain(PAT);
    expect(stored).not.toContain('held-testing-secret-value');
    expect(stored).not.toContain('hunter2');
    expect(stored).toContain('pendingSkillName');
  });

  it('leaves a clean turnError and clean messages as they were sent', async () => {
    const out = await applyTranscriptPatch({
      sessionId: 's-1',
      isDevice: true,
      isTerminal: false,
      patch: { turnError: 'exit 1', messages: [{ role: 'assistant', content: 'done' }] },
    });
    expect(recorded).toEqual(['exit 1']);
    expect(JSON.stringify(out.messages)).toContain('"done"');
  });
});
