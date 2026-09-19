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

  it('rejects a drive payload sent under another step name', () => {
    const wrong = { ...DRIVE_PAYLOAD, step: 'code' };
    expect(stepHandoffSchema.safeParse(wrong).success).toBe(false);
  });
});
