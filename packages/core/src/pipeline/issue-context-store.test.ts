import { describe, expect, it, vi } from 'vitest';
import type { StepHandoffPayload } from '../memory/step-handoff-schema.js';

// issue-context-store imports db/client at module load (env-gated); mock it —
// extractVerdict is pure and never touches the db.
vi.mock('../db/client.js', () => ({ db: {} }));

const { extractVerdict } = await import('./issue-context-store.js');

/**
 * ISS-381 (2.1) — the verdict promoted onto issue_step_contexts is derived from
 * the handoff payload at write time. These cover the mapping; the DB upsert
 * itself is exercised by the metrics read tests + integration.
 */
describe('extractVerdict (ISS-381 2.1)', () => {
  it('maps a review handoff verdict through unchanged', () => {
    for (const v of ['pass', 'needs_fix', 'no_change'] as const) {
      const payload = {
        step: 'review',
        schema_version: 1,
        verdict: v,
        findings: [],
        reviewedDiffSha: 'abc',
      } as StepHandoffPayload;
      expect(extractVerdict(payload)).toBe(v);
    }
  });

  it('maps a test handoff `result` onto the verdict column', () => {
    for (const r of ['pass', 'fail'] as const) {
      const payload = {
        step: 'test',
        schema_version: 1,
        result: r,
        failures: [],
        flakyTests: [],
      } as StepHandoffPayload;
      expect(extractVerdict(payload)).toBe(r);
    }
  });

  it('returns null for steps that carry no verdict', () => {
    const plan = {
      step: 'plan',
      schema_version: 1,
      planSummary: 'x',
      affectedFiles: [],
      acceptanceChecklist: [],
      unknowns: [],
    } as StepHandoffPayload;
    expect(extractVerdict(plan)).toBeNull();
  });
});
