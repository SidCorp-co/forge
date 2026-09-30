import { describe, expect, it } from 'vitest';
import { buildJobPromptString, type IssueSnapshot } from './prompt-string.js';

const SAMPLE: IssueSnapshot = {
  title: 'Add rate limiting to /api/agents',
  status: 'approved',
  priority: 'high',
  complexity: 'm',
  description: 'Throttle /api/agents/* to 10 req/min/user. Returns 429 with Retry-After header.',
  plan: '1. Add middleware in core/src/middleware/rate-limit.ts\n2. Wire into /api/agents routes\n3. Test with vitest',
  acceptanceCriteria:
    '- [ ] 429 returned after 10 req\n- [ ] Retry-After header present\n- [ ] Per-user not per-IP',
  sessionContext: null,
};

describe('buildJobPromptString', () => {
  it('returns /<skillName> <issueId> when a skill name is provided', () => {
    expect(
      buildJobPromptString({ skillName: 'forge-plan', jobType: 'plan', issueId: 'iss-1' }),
    ).toBe('/forge-plan iss-1');
    expect(
      buildJobPromptString({ skillName: 'custom-skill', jobType: 'code', issueId: 'iss-2' }),
    ).toBe('/custom-skill iss-2');
  });

  it('falls back to /forge-<jobType> when skillName is null/missing/empty', () => {
    expect(buildJobPromptString({ skillName: null, jobType: 'plan', issueId: 'iss-1' })).toBe(
      '/forge-plan iss-1',
    );
    expect(buildJobPromptString({ jobType: 'review', issueId: 'iss-2' })).toBe(
      '/forge-review iss-2',
    );
    expect(buildJobPromptString({ skillName: '', jobType: 'fix', issueId: 'iss-3' })).toBe(
      '/forge-fix iss-3',
    );
  });

  it('skips the ## Issue block when no snapshot is provided (legacy callers)', () => {
    const out = buildJobPromptString({
      skillName: 'forge-plan',
      jobType: 'plan',
      issueId: 'iss-1',
    });
    expect(out).toBe('/forge-plan iss-1');
    expect(out).not.toContain('## Issue');
  });

  describe('per-state issueSnapshot rendering (thin default — fetch-via-tool)', () => {
    it('every stage inlines NO body fields by default; carries title + forge_step_start pointer', () => {
      for (const jobType of ['triage', 'code', 'review', 'test', 'release'] as const) {
        const out = buildJobPromptString({ jobType, issueId: 'iss-1', issueSnapshot: SAMPLE });
        expect(out, jobType).toContain('## Issue');
        // ISS-532: the title is framed as untrusted DATA under a `Title:` label.
        expect(out, jobType).toContain('Title:');
        expect(out, jobType).toContain('Add rate limiting');
        expect(out, jobType).toContain('UNTRUSTED_DATA source="issue.title"');
        expect(out, jobType).not.toContain('Description:');
        expect(out, jobType).not.toContain('Plan:');
        expect(out, jobType).not.toContain('Acceptance:');
        expect(out, jobType).toContain('forge_step_start');
      }
    });

    it('renders metadata line with status/priority/complexity (always, no override needed)', () => {
      const out = buildJobPromptString({
        jobType: 'plan',
        issueId: 'iss-1',
        issueSnapshot: SAMPLE,
      });
      expect(out).toContain('Status: approved · Priority: high · Complexity: m');
    });
  });

  describe('sessionContext preamble', () => {
    it('skips the block when sessionCount = 0', () => {
      const out = buildJobPromptString({
        jobType: 'code',
        issueId: 'iss-1',
        issueSnapshot: {
          ...SAMPLE,
          sessionContext: {
            sessionCount: 0,
            currentState: 'fresh',
            decisions: ['use middleware'],
          },
        },
      });
      expect(out).not.toContain('## Previous Session Context');
    });

    it('renders the current state and the count, and never the per-field lists', () => {
      const out = buildJobPromptString({
        jobType: 'triage',
        issueId: 'iss-1',
        issueSnapshot: {
          ...SAMPLE,
          sessionContext: { sessionCount: 5, decisions: ['d1'], filesModified: ['f1'] },
        },
      });
      expect(out).toContain('## Previous Session Context');
      expect(out).not.toContain('**Key decisions:**');
      expect(out).not.toContain('**Files touched:**');
    });
  });

  it('e2e shape: skill line + issue block + session block for a code re-run', () => {
    const out = buildJobPromptString({
      skillName: 'forge-code',
      jobType: 'code',
      issueId: 'iss-42',
      issueSnapshot: {
        ...SAMPLE,
        sessionContext: {
          sessionCount: 1,
          currentState: 'resuming after CI failure',
          decisions: ['use middleware'],
          filesModified: ['middleware/rate-limit.ts'],
          errorsResolved: ['TS2304: redis types missing'],
        },
      },
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('/forge-code iss-42');
    expect(out.indexOf('## Issue')).toBeGreaterThan(0);
    expect(out.indexOf('## Previous Session Context')).toBeGreaterThan(out.indexOf('## Issue'));
  });
});
