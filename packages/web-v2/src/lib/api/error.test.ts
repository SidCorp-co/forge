import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { formatApiError, formatPipelineConfigError, isRetryableApiError } from './error';

describe('formatPipelineConfigError', () => {
  it('names the offending stage for MISSING_SKILL_FOR_ENABLED_STAGE', () => {
    const err = new ApiError(
      409,
      'enabled auto-stage toggles require a registered skill for the corresponding stage',
      'MISSING_SKILL_FOR_ENABLED_STAGE',
      { stagesMissingSkill: ['open'] },
    );
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Auto triage');
    expect(msg).toMatch(/register a skill/i);
    expect(msg).toMatch(/toggle off/i);
  });

  it('handles AUTO_STAGE_NEEDS_SKILL the same way', () => {
    const err = new ApiError(409, 'auto-mode stages require a registered skill', 'AUTO_STAGE_NEEDS_SKILL', {
      stagesMissingSkill: ['developed'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Auto review');
  });

  it('names multiple missing-skill stages', () => {
    const err = new ApiError(409, 'x', 'MISSING_SKILL_FOR_ENABLED_STAGE', {
      stagesMissingSkill: ['open', 'testing'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Auto triage');
    expect(msg).toContain('Auto test');
  });

  it('reports blocking issue count for STAGE_HAS_ISSUES', () => {
    const err = new ApiError(409, 'cannot disable stages while issues are at those stages', 'STAGE_HAS_ISSUES', {
      stagesBlocked: ['developed'],
      blockingIssueIds: ['x', 'y'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Auto review');
    expect(msg).toContain('2');
    expect(msg).toMatch(/move or close/i);
  });

  it('lists unreachable stages for DEAD_END_CONFIG', () => {
    const err = new ApiError(400, 'Cannot disable stages with no forward path: testing', 'DEAD_END_CONFIG', {
      unreachable: ['testing'],
    });
    const msg = formatPipelineConfigError(err);
    expect(msg).toContain('Auto test');
    expect(msg).toMatch(/no forward path/i);
  });

  it('explains OPEN_LOCKED_ON', () => {
    const err = new ApiError(400, 'open stage cannot be disabled', 'OPEN_LOCKED_ON');
    expect(formatPipelineConfigError(err)).toMatch(/Open stage can't be disabled/i);
  });

  it('falls back to the raw status name for non-toggle stages', () => {
    const err = new ApiError(409, 'x', 'STAGE_HAS_ISSUES', {
      stagesBlocked: ['waiting'],
      blockingIssueIds: ['a'],
    });
    expect(formatPipelineConfigError(err)).toContain('waiting');
  });

  it('falls back to formatApiError when details is missing/odd', () => {
    const err = new ApiError(409, 'enabled auto-stage toggles require a registered skill', 'MISSING_SKILL_FOR_ENABLED_STAGE');
    // No usable details → identical to the generic formatter (the raw message).
    expect(formatPipelineConfigError(err)).toBe(formatApiError(err));
  });

  it('falls back to formatApiError for non-pipeline ApiError codes', () => {
    const err = new ApiError(403, 'nope', 'FORBIDDEN');
    expect(formatPipelineConfigError(err)).toBe(formatApiError(err));
  });

  it('falls back to formatApiError for a generic Error', () => {
    const err = new Error('boom');
    expect(formatPipelineConfigError(err)).toBe(formatApiError(err));
  });
});

/**
 * ISS-1160 — no screen offers Retry on a refusal that retrying cannot change.
 * A 4xx is the same request meeting the same answer again; only a 5xx or a
 * transport failure (not an ApiError at all) is worth resubmitting.
 */
describe('isRetryableApiError', () => {
  it('refuses retry on a 400 — the malformed-identifier / missing-scope refusal', () => {
    expect(isRetryableApiError(new ApiError(400, 'Invalid input', 'BAD_REQUEST'))).toBe(false);
  });

  it('refuses retry on a 404 — the key-names-nothing refusal', () => {
    expect(isRetryableApiError(new ApiError(404, 'not found', 'NOT_FOUND'))).toBe(false);
  });

  it('refuses retry on a 403 — the project-the-caller-cannot-read refusal', () => {
    expect(isRetryableApiError(new ApiError(403, 'nope', 'FORBIDDEN'))).toBe(false);
  });

  it('allows retry on a 500 — a server fault the same request might not repeat', () => {
    expect(isRetryableApiError(new ApiError(500, 'boom', 'INTERNAL_ERROR'))).toBe(true);
  });

  it('allows retry on a non-ApiError — a transport failure, not a refusal', () => {
    expect(isRetryableApiError(new Error('fetch failed'))).toBe(true);
  });
});
