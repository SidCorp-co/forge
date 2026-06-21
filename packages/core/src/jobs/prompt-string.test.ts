import { describe, expect, it } from 'vitest';
import { type IssueSnapshot, buildJobPromptString } from './prompt-string.js';

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

    it('includeFields override re-inlines the requested fields', () => {
      const out = buildJobPromptString({
        jobType: 'code',
        issueId: 'iss-1',
        issueSnapshot: SAMPLE,
        policy: { includeFields: ['description', 'plan', 'acceptanceCriteria'] },
      });
      expect(out).toContain('Description:');
      expect(out).toContain('Plan:');
      expect(out).toContain('rate-limit.ts');
      expect(out).toContain('Acceptance:');
      expect(out).toContain('429 returned');
    });

    it('renders metadata line with status/priority/complexity (always, no override needed)', () => {
      const out = buildJobPromptString({
        jobType: 'plan',
        issueId: 'iss-1',
        issueSnapshot: SAMPLE,
      });
      expect(out).toContain('Status: approved · Priority: high · Complexity: m');
    });

    it('truncates long description with marker that names char count + tool hint', () => {
      const longDesc = 'x'.repeat(9000);
      const out = buildJobPromptString({
        jobType: 'code',
        issueId: 'iss-1',
        issueSnapshot: { ...SAMPLE, description: longDesc },
        policy: { includeFields: ['description', 'plan'] },
      });
      // Marker includes the cut position + original length + tool hint
      expect(out).toMatch(
        /… \[truncated at \d+\/9000 chars — call forge_issues\.get for full body\]/,
      );
      const descSection = out.slice(out.indexOf('Description:'), out.indexOf('Plan:'));
      expect(descSection.length).toBeLessThan(9000);
    });

    it('truncates at paragraph boundary when one exists within window', () => {
      // Build a description where a clean \n\n boundary sits inside the
      // [80% cap, cap] window. The cut should land exactly there.
      const head = 'A'.repeat(6500);
      const tail = 'B'.repeat(2500);
      const desc = `${head}\n\n${tail}`;
      const out = buildJobPromptString({
        jobType: 'code',
        issueId: 'iss-1',
        issueSnapshot: { ...SAMPLE, description: desc },
        policy: { includeFields: ['description', 'plan'] },
      });
      // Body must end at the head paragraph — no B's should leak through.
      const descSection = out.slice(out.indexOf('Description:'), out.indexOf('Plan:'));
      expect(descSection).not.toContain('B');
      // And it should include the truncation marker.
      expect(descSection).toContain('[truncated at');
    });

    it('falls back to byte cut when no boundary exists within window', () => {
      // No spaces, no newlines → boundary search returns -1 → cut at cap.
      const desc = 'z'.repeat(9000);
      const out = buildJobPromptString({
        jobType: 'code',
        issueId: 'iss-1',
        issueSnapshot: { ...SAMPLE, description: desc },
        policy: { includeFields: ['description', 'plan'] },
      });
      const descSection = out.slice(out.indexOf('Description:'), out.indexOf('Plan:'));
      // Cut should be at the cap (8000); marker reports it.
      expect(descSection).toMatch(/\[truncated at 8000\/9000 chars/);
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

    it('renders the block for code when sessionCount >= 1 (fields re-enabled via override)', () => {
      const out = buildJobPromptString({
        jobType: 'code',
        issueId: 'iss-1',
        issueSnapshot: {
          ...SAMPLE,
          sessionContext: {
            sessionCount: 2,
            currentState: 'mid-implementation, build green',
            decisions: ['use middleware (not per-route)', 'redis backend for counts'],
            filesModified: ['packages/core/src/middleware/rate-limit.ts'],
            errorsResolved: ['ECONNREFUSED redis on test'],
            reviewFeedback: ['expand AC for X-RateLimit-* headers'],
            lastUpdated: '2026-05-20T12:00:00Z',
          },
        },
        policy: {
          sessionContext: {
            fields: ['decisions', 'filesModified', 'errorsResolved', 'reviewFeedback'],
          },
        },
      });
      expect(out).toContain('## Previous Session Context');
      expect(out).toContain('**Current state:** mid-implementation');
      expect(out).toContain('**Key decisions:**');
      expect(out).toContain('use middleware');
      expect(out).toContain('**Files touched:**');
      expect(out).toContain('rate-limit.ts');
      expect(out).toContain('**Errors resolved:**');
      expect(out).toContain('ECONNREFUSED');
      expect(out).toContain('**Review feedback:**');
      expect(out).toContain('Context from 2 previous session(s)');
    });

    it('sessionContext.fields override gates which fields render (decisions + filesModified only)', () => {
      const out = buildJobPromptString({
        jobType: 'review',
        issueId: 'iss-1',
        issueSnapshot: {
          ...SAMPLE,
          sessionContext: {
            sessionCount: 1,
            decisions: ['d1'],
            filesModified: ['f1'],
            errorsResolved: ['e1'],
            reviewFeedback: ['fb1'],
          },
        },
        policy: { sessionContext: { fields: ['decisions', 'filesModified'] } },
      });
      expect(out).toContain('**Key decisions:**');
      expect(out).toContain('**Files touched:**');
      expect(out).not.toContain('**Errors resolved:**');
      expect(out).not.toContain('**Review feedback:**');
    });

    it('triage skips sessionContext entirely even with sessionCount >= 1', () => {
      const out = buildJobPromptString({
        jobType: 'triage',
        issueId: 'iss-1',
        issueSnapshot: {
          ...SAMPLE,
          sessionContext: { sessionCount: 5, decisions: ['d1'], filesModified: ['f1'] },
        },
      });
      expect(out).toContain('## Previous Session Context');
      // Triage policy: no decisions, no filesModified rendered
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
