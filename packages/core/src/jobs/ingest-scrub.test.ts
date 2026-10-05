import { scrubSecretsDeep } from '@forge/observability';
import { describe, expect, it, vi } from 'vitest';

const HELD = 'held-testing-secret-value';
const PAT = 'forge_pat_dev_0123456789abcdef0123456789abcdef';

const finish = vi.fn(async (args: { set: { error: string } }) => ({
  id: 'job-1',
  status: 'failed',
  error: args.set.error,
}));
const finalize = vi.fn(async (_row: unknown, _opts: { error: string }) => null);

vi.mock('./service.js', () => ({ finishJobFromRunner: finish }));
vi.mock('./finalize-done.js', () => ({ settleTranscriptAndUsage: vi.fn() }));
vi.mock('./finalize-failure.js', () => ({ finalizeFailedJob: finalize }));
vi.mock('./handle-resume-failed.js', () => ({
  isResumeFailedError: () => false,
  reclassifyAbortedResume: vi.fn(),
}));
vi.mock('./prior-attempts.js', () => ({ salvageSet: () => ({}) }));
vi.mock('./refusals.js', () => ({ refuseJob: (code: string) => new Error(code) }));
vi.mock('./job-secret-scrub.js', () => ({
  scrubJobOutput: vi.fn(async (_ids: readonly string[], data: unknown) =>
    scrubSecretsDeep(data, [HELD]),
  ),
}));

const { failJobFromRunner } = await import('./runner-finish.js');

describe("a box's job failure is stored scrubbed", () => {
  it('scrubs jobs.error, the transition reason and what the retry decision is handed', async () => {
    const out = await failJobFromRunner(
      { id: 'job-1', status: 'running' } as never,
      { error: `git push failed: https://x:${PAT}@github.com/a/b and ${HELD}` },
      'device-1',
    );
    const call = finish.mock.calls[0]?.[0] as unknown as { set: { error: string }; reason: string };
    for (const stored of [
      call.set.error,
      call.reason,
      out.error ?? '',
      finalize.mock.calls[0]?.[1].error ?? '',
    ]) {
      expect(stored).not.toContain(PAT);
      expect(stored).not.toContain(HELD);
      expect(stored).toContain('git push failed');
    }
  });
});
