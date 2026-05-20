import { describe, expect, it } from 'vitest';
import type { JobType } from '../db/schema.js';
import { type IssueSnapshot, buildJobPromptString } from './prompt-string.js';

const FULL_SNAPSHOT: IssueSnapshot = {
  title: 'Sample issue',
  status: 'in_progress',
  priority: 'high',
  complexity: 's',
  description: 'desc body',
  plan: 'plan body',
  acceptanceCriteria: 'ac body',
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

  it('emits only the head line for every jobType when issueSnapshot is absent', () => {
    const types: JobType[] = [
      'triage',
      'clarify',
      'plan',
      'code',
      'review',
      'test',
      'release',
      'fix',
      'custom',
      'pm',
    ];
    for (const jobType of types) {
      expect(buildJobPromptString({ jobType, issueId: 'iss-9' })).toBe(`/forge-${jobType} iss-9`);
    }
  });

  describe('per-state include rules (with full snapshot)', () => {
    function out(jobType: JobType): string {
      return buildJobPromptString({ jobType, issueId: 'iss-1', issueSnapshot: FULL_SNAPSHOT });
    }

    it('triage: title + status line + description; no plan/acceptance', () => {
      const s = out('triage');
      expect(s).toContain('## Issue');
      expect(s).toContain('Title: Sample issue');
      expect(s).toContain('Status: in_progress · Priority: high · Complexity: s');
      expect(s).toContain('Description:');
      expect(s).not.toContain('Plan:');
      expect(s).not.toContain('Acceptance:');
    });

    it('clarify: description + acceptance; no plan', () => {
      const s = out('clarify');
      expect(s).toContain('Description:');
      expect(s).toContain('Acceptance:');
      expect(s).not.toContain('Plan:');
    });

    it('plan: description + acceptance; no plan body', () => {
      const s = out('plan');
      expect(s).toContain('Description:');
      expect(s).toContain('Acceptance:');
      expect(s).not.toContain('Plan:');
    });

    it('code: description + plan + acceptance', () => {
      const s = out('code');
      expect(s).toContain('Description:');
      expect(s).toContain('Plan:');
      expect(s).toContain('Acceptance:');
    });

    it('review: plan + acceptance; no description', () => {
      const s = out('review');
      expect(s).not.toContain('Description:');
      expect(s).toContain('Plan:');
      expect(s).toContain('Acceptance:');
    });

    it('test: acceptance only', () => {
      const s = out('test');
      expect(s).not.toContain('Description:');
      expect(s).not.toContain('Plan:');
      expect(s).toContain('Acceptance:');
    });

    it('release: title + status line only', () => {
      const s = out('release');
      expect(s).toContain('Title: Sample issue');
      expect(s).not.toContain('Description:');
      expect(s).not.toContain('Plan:');
      expect(s).not.toContain('Acceptance:');
    });

    it('fix: description + plan + acceptance', () => {
      const s = out('fix');
      expect(s).toContain('Description:');
      expect(s).toContain('Plan:');
      expect(s).toContain('Acceptance:');
    });
  });

  it('omits a section whose source field is null even when the matrix includes it', () => {
    const s = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: { ...FULL_SNAPSHOT, description: null },
    });
    expect(s).not.toContain('Description:');
    expect(s).toContain('Acceptance:');
  });

  it('omits a section whose source field is whitespace-only', () => {
    const s = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: { ...FULL_SNAPSHOT, description: '   \n  ' },
    });
    expect(s).not.toContain('Description:');
  });

  it('truncates description over the 8000-char cap with the … [truncated] marker', () => {
    const longDescription = 'x'.repeat(8001);
    const s = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: { ...FULL_SNAPSHOT, description: longDescription },
    });
    const marker = '\n… [truncated]';
    const occurrences = s.split(marker).length - 1;
    expect(occurrences).toBe(1);

    const descStart = s.indexOf('Description:\n') + 'Description:\n'.length;
    const descEnd = s.indexOf('\n\nAcceptance:');
    expect(descEnd).toBeGreaterThan(descStart);
    const descBody = s.slice(descStart, descEnd);
    expect(descBody.endsWith('\n… [truncated]')).toBe(true);
    expect(descBody.length).toBeLessThanOrEqual(8000 + '\n… [truncated]'.length);
  });

  it('truncates plan over the 16000-char cap', () => {
    const longPlan = 'p'.repeat(16001);
    const s = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: { ...FULL_SNAPSHOT, plan: longPlan },
    });
    const planStart = s.indexOf('Plan:\n') + 'Plan:\n'.length;
    const planEnd = s.indexOf('\n\nAcceptance:');
    const planBody = s.slice(planStart, planEnd);
    expect(planBody.endsWith('\n… [truncated]')).toBe(true);
    expect(planBody.length).toBeLessThanOrEqual(16000 + '\n… [truncated]'.length);
  });

  it('truncates acceptance over the 4000-char cap', () => {
    const longAc = 'a'.repeat(4001);
    const s = buildJobPromptString({
      jobType: 'test',
      issueId: 'iss-1',
      issueSnapshot: { ...FULL_SNAPSHOT, acceptanceCriteria: longAc },
    });
    expect(s.endsWith('\n… [truncated]')).toBe(true);
  });

  it('renders complexity:null as "unknown" in the status line', () => {
    const s = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: { ...FULL_SNAPSHOT, complexity: null },
    });
    expect(s).toContain('Complexity: unknown');
  });

  it('preserves the skillName fallback when a snapshot is supplied', () => {
    const s = buildJobPromptString({
      skillName: null,
      jobType: 'code',
      issueId: 'iss-7',
      issueSnapshot: FULL_SNAPSHOT,
    });
    expect(s.startsWith('/forge-code iss-7\n')).toBe(true);
    expect(s).toContain('## Issue');
  });
});
