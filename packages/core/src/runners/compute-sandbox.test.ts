import type { ExecutionRequest } from '@forge/contracts/report-executions';
import { describe, expect, it } from 'vitest';
import {
  boxBar,
  createRunnerSandboxExecutor,
  resultOfAnswer,
  type SandboxBox,
} from './compute-sandbox.js';

const box = (over: Partial<SandboxBox> = {}): SandboxBox => ({
  deviceId: 'd-1',
  runnerId: 'r-1',
  name: 'build-box',
  runnerStatus: 'online',
  disabled: false,
  capabilities: { computeSandbox: true, computeSandboxLanguages: ['bash', 'python'] },
  ...over,
});

const request: ExecutionRequest = {
  language: 'python',
  script: 'print(1)',
  inputs: [],
  limits: { wallMs: 1000, cpu: 1, memoryMb: 256, outputBytes: 10_000 },
};
const ran = {
  projectId: '00000000-0000-4000-8000-000000000001',
  exit: 0,
  durationMs: 4,
  stdout: '',
  stderr: '',
};

describe('which box may take a computation', () => {
  it('takes a connected box that declares the sandbox and the language', () => {
    expect(boxBar(box(), 'python', true)).toBeNull();
  });

  it('names a box turned off, draining or disabled for the project before anything else', () => {
    expect(boxBar(box({ disabled: true }), 'python', true)).toBe(
      'the runner box build-box is turned off',
    );
    expect(boxBar(box({ runnerStatus: 'draining' }), 'python', true)).toContain('is draining');
    expect(boxBar(box({ runnerStatus: 'disabled' }), 'python', true)).toContain('is disabled');
  });

  it('names a box with no interpreter list as running none', () => {
    expect(boxBar(box({ capabilities: { computeSandbox: true } }), 'bash', true)).toContain(
      'has no bash interpreter its sandbox can run (it runs none)',
    );
  });

  it('refuses before any frame where no box is bound, and sends nothing', async () => {
    const sent: unknown[] = [];
    const executor = createRunnerSandboxExecutor({
      boxesOf: async () => [],
      listening: () => true,
      send: (_d, e) => sent.push(e),
    });
    const can = await executor.availableFor({
      id: 'p-1',
      compute: { enabled: true },
      language: 'python',
    });
    expect(can).toEqual({
      unavailable: expect.stringContaining('no runner is paired with this project'),
    });
    await expect(
      executor.execute(request, { projectId: 'p-1', conversationId: null, askedBy: 'u-1' }),
    ).rejects.toThrow('nothing was sent');
    expect(sent).toEqual([]);
  });

  it('settles as disconnected where no socket took the frame', async () => {
    const executor = createRunnerSandboxExecutor({
      boxesOf: async () => [box()],
      listening: () => true,
      send: () => 0,
    });
    await expect(
      executor.execute(request, { projectId: 'p-1', conversationId: null, askedBy: 'u-1' }),
    ).rejects.toThrow('disconnected before the script was handed over');
  });
});

describe('what the box answered, as the port result', () => {
  it('names the limit that stopped the script and draws no frame', () => {
    const result = resultOfAnswer('x-1', { ...ran, exit: 152, stopped: 'cpu' }, request);
    expect(result).toMatchObject({
      adapter: 'runner-sandbox',
      exit: 152,
      stopped: 'cpu',
      frames: [],
      error: { name: 'CpuLimit', message: 'the script ran past limits.cpu of 1 and was stopped' },
    });
  });

  it('says the script wrote no frames where the box handed back no output', () => {
    expect(resultOfAnswer('x-1', ran, request).error?.name).toBe('NoFrames');
  });
});
