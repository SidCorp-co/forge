import { describe, expect, it, vi } from 'vitest';

// Importing the guard module pulls in the db client, which validates env at
// module load. The pure helpers under test do not touch the DB, so stub the
// client to avoid requiring DATABASE_URL in unit-test runs.
vi.mock('../db/client.js', () => ({ db: {} }));
// The shared pause writer (run-pause.ts) pulls in ws/server → auth/cookie →
// env validation; stub it for the same reason.
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const {
  PAUSE_REASON_PREFIX,
  buildMissingSkillCommentBody,
  buildMissingSkillReason,
} = await import('./missing-skill-guard.js');

describe('pipeline/missing-skill-guard', () => {
  it('builds the pauseReason with the expected prefix', () => {
    expect(buildMissingSkillReason('developed')).toBe(`${PAUSE_REASON_PREFIX}developed`);
    expect(buildMissingSkillReason('approved')).toBe('missing_skill:approved');
  });

  it('builds an English comment body that names the stage and toggle', () => {
    const body = buildMissingSkillCommentBody('developed');
    expect(body).toContain('Pipeline halted');
    expect(body).toContain('`developed`');
    // Toggle name comes from PIPELINE_STEPS — `developed` → `autoReview`, not
    // the naive `autoDeveloped`.
    expect(body).toContain('autoReview');
    expect(body).toContain('Required action');
    // English-only per project rule — no Vietnamese carry-over from the spec. i18n-allow: regex tests for absence
    expect(body).not.toMatch(/Lý do|Yêu cầu|được kích hoạt/); // i18n-allow: assertion-only
  });
});
