import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn() },
}));

const { classifyVerdict } = await import('./recovery-verifier.js');

describe('classifyVerdict (pure)', () => {
  it('triage job, issue at open → pending', () => {
    expect(classifyVerdict('open', 'triage')).toBe('pending');
  });

  it('triage job, issue at approved → advanced (approved is a triage exit)', () => {
    expect(classifyVerdict('approved', 'triage')).toBe('advanced');
  });

  it('triage job, issue at in_progress → pending (the step runs inside in_progress)', () => {
    expect(classifyVerdict('in_progress', 'triage')).toBe('pending');
  });

  it('triage job, issue at needs_info → advanced (needs_info is a triage exit)', () => {
    expect(classifyVerdict('needs_info', 'triage')).toBe('advanced');
  });

  it('clarify job, issue at open → pending (still at entry)', () => {
    expect(classifyVerdict('open', 'clarify')).toBe('pending');
  });

  it('clarify job, issue at approved → advanced', () => {
    expect(classifyVerdict('approved', 'clarify')).toBe('advanced');
  });

  it('clarify job, issue at needs_info → advanced (cannot-reproduce bounce)', () => {
    expect(classifyVerdict('needs_info', 'clarify')).toBe('advanced');
  });

  it('plan job, issue at open → pending (still at entry)', () => {
    expect(classifyVerdict('open', 'plan')).toBe('pending');
  });

  it('plan job, issue at in_progress → pending (mid-flight)', () => {
    expect(classifyVerdict('in_progress', 'plan')).toBe('pending');
  });

  it('plan job, issue at approved → advanced', () => {
    expect(classifyVerdict('approved', 'plan')).toBe('advanced');
  });

  it('plan job, issue at reopen → reverted (reopen is owned by fix)', () => {
    expect(classifyVerdict('reopen', 'plan')).toBe('reverted');
  });

  it('code job, issue at closed → advanced (terminal status)', () => {
    expect(classifyVerdict('closed', 'code')).toBe('advanced');
  });

  it('code job, issue at released → advanced (terminal status)', () => {
    expect(classifyVerdict('awaiting_release', 'code')).toBe('advanced');
  });

  it('code job, issue at in_progress → pending (build and test are steps inside in_progress)', () => {
    expect(classifyVerdict('in_progress', 'code')).toBe('pending');
  });

  it('code job, issue at approved → pending', () => {
    expect(classifyVerdict('approved', 'code')).toBe('pending');
  });

  it('review job, issue at awaiting_release → advanced', () => {
    expect(classifyVerdict('awaiting_release', 'review')).toBe('advanced');
  });

  it('review job, issue at in_progress → pending (no entry, still mid-flight)', () => {
    expect(classifyVerdict('in_progress', 'review')).toBe('pending');
  });

  it('review job, issue at reopen → advanced (review can route back to fix)', () => {
    expect(classifyVerdict('reopen', 'review')).toBe('advanced');
  });

  it('release job, issue at closed → advanced (terminal)', () => {
    expect(classifyVerdict('closed', 'release')).toBe('advanced');
  });

  it('fix job, issue at awaiting_release → advanced', () => {
    expect(classifyVerdict('awaiting_release', 'fix')).toBe('advanced');
  });

  it('fix job, issue at reopen → pending (still at entry)', () => {
    expect(classifyVerdict('reopen', 'fix')).toBe('pending');
  });

  it('custom job, any status → pending (no entry mapping)', () => {
    expect(classifyVerdict('approved', 'custom')).toBe('pending');
  });

  it('pm job, any status → pending (no entry mapping)', () => {
    expect(classifyVerdict('open', 'pm')).toBe('pending');
  });

  it('code job, issue at open → reverted (regressed below the plan checkpoint)', () => {
    expect(classifyVerdict('open', 'code')).toBe('reverted');
  });

  it('ISS-702: code job, issue at needs_info → reverted (parked by a later step; must not be reverted to approved)', () => {
    expect(classifyVerdict('needs_info', 'code')).toBe('reverted');
  });
});
