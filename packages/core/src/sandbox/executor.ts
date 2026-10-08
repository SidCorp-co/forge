// The reports Executor port's adapter (REQ-32 BC-16): a chat or Agent-mode computation runs in the
// same script sandbox a schedule script does, reading Forge through ctx.forge.get as the asker. The
// script gets the input frames as ctx.inputs and returns { frames }; what it read is returned with
// the result for the execution's record. Nothing leaves Forge, and no network is reachable.

import { randomUUID } from 'node:crypto';
import {
  EXECUTION_LOG_CAP_BYTES,
  EXECUTOR_DATA_STAYS_WITH_FORGE,
  type ExecutionResult,
  type Executor,
  framesFromReturn,
} from '@forge/contracts/report-executions';
import { SCRIPT_LANGUAGE } from '@forge/contracts/script-sandbox';
import { openForgeReader } from './forge-read.js';
import { runScript } from './run.js';

/** How long past the run's wall cap its read token lives, so it never outlives the run by more. */
const TOKEN_MARGIN_MS = 5_000;

export const sandboxExecutor: Executor = {
  id: 'forge-sandbox',
  mode: 'invoked',
  isolation: 'quickjs-wasm',
  network: 'none',
  dataLeavesTo: EXECUTOR_DATA_STAYS_WITH_FORGE,
  zdrEligible: true,
  availableFor: ({ language }) =>
    language === SCRIPT_LANGUAGE
      ? true
      : { unavailable: `the script sandbox runs ${SCRIPT_LANGUAGE} alone, not ${language}` },
  async execute(request, scope): Promise<ExecutionResult> {
    const reader = openForgeReader({
      projectId: scope.projectId,
      owner: { userId: scope.askedBy, viaTokenId: scope.viaTokenId },
      ttlMs: request.limits.wallMs + TOKEN_MARGIN_MS,
    });
    try {
      const run = await runScript({
        script: request.script,
        projectId: scope.projectId,
        inputs: request.inputs,
        limits: {
          wallMs: request.limits.wallMs,
          memoryMb: request.limits.memoryMb,
          logChars: EXECUTION_LOG_CAP_BYTES,
        },
        read: reader.read,
      });
      let error = run.error;
      let frames: ExecutionResult['frames'] = [];
      if (run.status === 'success') {
        const read = framesFromReturn(run.value);
        if (read.ok) frames = read.frames;
        else error = { name: 'FramesInvalid', message: read.why };
      }
      return {
        executionId: randomUUID(),
        adapter: sandboxExecutor.id,
        exit: error ? 1 : 0,
        durationMs: run.durationMs,
        ...(run.stopped ? { stopped: run.stopped } : {}),
        frames,
        logs: { stdout: run.output, stderr: error ? `${error.name}: ${error.message}` : '' },
        ...(error ? { error } : {}),
        reads: reader.reads(),
      };
    } finally {
      await reader.close();
    }
  },
};
