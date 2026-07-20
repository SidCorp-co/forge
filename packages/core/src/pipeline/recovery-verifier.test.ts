import { describe, expect, it, vi } from 'vitest';

// recovery-verifier.ts imports db/client transitively; stub it so the pure
// `classifyVerdict` test doesn't need DATABASE_URL.
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn() },
}));

const { classifyVerdict } = await import('./recovery-verifier.js');

describe('classifyVerdict (pure)', () => {
  it('triage job, issue at open → pending', () => {
    expect(classifyVerdict('open', 'triage')).toBe('pending');
  });

  it('triage job, issue at confirmed → advanced (confirmed is a triage exit)', () => {
    expect(classifyVerdict('confirmed', 'triage')).toBe('advanced');
  });

  it('triage job, issue at needs_info → advanced (needs_info is a triage exit)', () => {
    expect(classifyVerdict('needs_info', 'triage')).toBe('advanced');
  });

  it('clarify job, issue at confirmed → pending (still at entry)', () => {
    expect(classifyVerdict('confirmed', 'clarify')).toBe('pending');
  });

  it('clarify job, issue at clarified → advanced', () => {
    expect(classifyVerdict('clarified', 'clarify')).toBe('advanced');
  });

  it('clarify job, issue at needs_info → advanced (cannot-reproduce bounce)', () => {
    expect(classifyVerdict('needs_info', 'clarify')).toBe('advanced');
  });

  it('plan job, issue at clarified → pending', () => {
    expect(classifyVerdict('clarified', 'plan')).toBe('pending');
  });

  it('plan job, issue at approved → advanced', () => {
    expect(classifyVerdict('approved', 'plan')).toBe('advanced');
  });

  it('plan job, issue at developed → reverted (developed is owned by review)', () => {
    expect(classifyVerdict('developed', 'plan')).toBe('reverted');
  });

  it('code job, issue at closed → advanced (terminal status)', () => {
    expect(classifyVerdict('closed', 'code')).toBe('advanced');
  });

  it('code job, issue at released → advanced (terminal status)', () => {
    expect(classifyVerdict('released', 'code')).toBe('advanced');
  });

  it('code job, issue at developed → advanced', () => {
    expect(classifyVerdict('developed', 'code')).toBe('advanced');
  });

  it('code job, issue at approved → pending', () => {
    expect(classifyVerdict('approved', 'code')).toBe('pending');
  });

  it('review job, issue at testing → advanced', () => {
    expect(classifyVerdict('testing', 'review')).toBe('advanced');
  });

  it('review job, issue at reopen → advanced (review can route back to fix)', () => {
    expect(classifyVerdict('reopen', 'review')).toBe('advanced');
  });

  it('release job, issue at closed → advanced (terminal)', () => {
    expect(classifyVerdict('closed', 'release')).toBe('advanced');
  });

  it('fix job, issue at developed → advanced', () => {
    expect(classifyVerdict('developed', 'fix')).toBe('advanced');
  });

  it('custom job, any status → pending (no entry mapping)', () => {
    expect(classifyVerdict('approved', 'custom')).toBe('pending');
  });

  it('pm job, any status → pending (no entry mapping)', () => {
    expect(classifyVerdict('open', 'pm')).toBe('pending');
  });

  it('plan job, issue at open → reverted (regressed below entry)', () => {
    expect(classifyVerdict('open', 'plan')).toBe('reverted');
  });

  it('ISS-702: code job, issue at waiting → reverted (parked by a later step; must not be reverted to approved)', () => {
    expect(classifyVerdict('waiting', 'code')).toBe('reverted');
  });
});
