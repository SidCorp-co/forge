// ISS-904 (owner, 2026-11-02, "lift the limits"): a step leaves open every question it could not
// settle. `POST /api/issue-step-contexts` validates its payload with this schema, so a count here is
// a count on how many questions stand open; only the list's bytes are bounded.
import { describe, expect, it } from 'vitest';
import { HANDOFF_QUESTIONS_MAX_BYTES, stepHandoffSchema } from './step-handoff-schema.js';

const questions = (n: number, length = 20) =>
  Array.from({ length: n }, (_, i) => `Open question ${i}: ${'x'.repeat(length)}`);

const clarify = (openQuestions: string[]) => ({
  step: 'clarify',
  schema_version: 1,
  outcome: 'reproduced',
  stepsVerified: [],
  openQuestions,
});
const drive = (openQuestions: string[]) => ({
  step: 'drive',
  schema_version: 1,
  outcome: 'parked',
  summary: 'Parked on the questions below.',
  workDone: [],
  openQuestions,
});
const plan = (unknowns: string[]) => ({
  step: 'plan',
  schema_version: 1,
  planSummary: 'Clear the order cache on reorder.',
  affectedFiles: [],
  acceptanceChecklist: [],
  unknowns,
});

describe('a step handoff carries every question it leaves open (ISS-904)', () => {
  it.each([
    ['clarify', clarify],
    ['drive', drive],
    ['plan', plan],
  ])('takes eleven open questions on a %s handoff', (_step, handoff) => {
    expect(stepHandoffSchema.safeParse(handoff(questions(11))).success).toBe(true);
  });

  it('refuses a list over its byte bound by the bound, not by a count', () => {
    const parsed = stepHandoffSchema.safeParse(drive(questions(100, 1_000)));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(`${HANDOFF_QUESTIONS_MAX_BYTES} bytes`);
  });
});
