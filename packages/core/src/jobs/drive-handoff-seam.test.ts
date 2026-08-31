/**
 * ISS-888 item 1 — the seam, asserted from both sides.
 *
 * `finalize-done.ts` can only rescue a job whose step actually produced a
 * handoff row, and only the prompt makes an agent produce one. Those two facts
 * live far apart and nothing linked them: `drive` was readable by the
 * finalizer and invisible to the prompt, so the rescue was unreachable on
 * exactly the projects that run autonomously.
 *
 * These assertions fail if either half is removed, which is the point — a test
 * that only pins the finalizer stays green while the signal it reads can never
 * be written.
 */

import { describe, expect, it } from 'vitest';
import {
  HANDOFF_STEPS,
  isHandoffStep,
  renderTerminationBlock,
  stepHandoffSchema,
} from '../memory/step-handoff-schema.js';

const DRIVE_PAYLOAD = {
  step: 'drive',
  schema_version: 1,
  outcome: 'parked',
  summary: 'Reproduced the report, moved the issue to needs_info with the missing detail.',
  workDone: ['read the issue', 'posted a comment', 'set status needs_info'],
  openQuestions: ['which tenant was affected?'],
};

describe('ISS-888 — drive can produce the completion signal the finalizer reads', () => {
  it('the prompt asks a drive turn for a handoff', () => {
    expect(isHandoffStep('drive')).toBe(true);
    expect(HANDOFF_STEPS).toContain('drive');

    const block = renderTerminationBlock({
      step: 'drive',
      scope: { projectId: 'p1', issueId: 'i1', runId: 'r1', attempt: 1 },
    });
    expect(block).toContain('forge_step_handoff.write');
    expect(block).toContain('"step": "drive"');
  });

  it('the MCP boundary accepts the drive payload the prompt describes', () => {
    expect(stepHandoffSchema.safeParse(DRIVE_PAYLOAD).success).toBe(true);
  });

  // cm:guard the finalizer probes `issue_step_contexts.step = jobs.type`, so the discriminator the agent sends MUST be the literal job type — a handoff written under any other name is a row the rescue cannot find, and the job retries with the work already done.
  it('rejects a drive payload sent under another step name', () => {
    const wrong = { ...DRIVE_PAYLOAD, step: 'code' };
    expect(stepHandoffSchema.safeParse(wrong).success).toBe(false);
  });
});
