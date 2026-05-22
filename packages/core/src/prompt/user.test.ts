import { describe, expect, it } from 'vitest';
import { buildJobPromptString, type IssueSnapshot } from './user.js';

const SAMPLE: IssueSnapshot = {
  title: 'Add rate limiting',
  description: 'Throttle endpoints',
  plan: '1. Add middleware\n2. Wire routes',
  acceptanceCriteria: '- [ ] 429 returned',
  sessionContext: null,
};

describe('buildJobPromptString policy overrides', () => {
  it('includeFields override expands beyond per-state default', () => {
    // Default for `triage` is [description]. Override should add plan + AC.
    const out = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: SAMPLE,
      policy: { includeFields: ['description', 'plan', 'acceptanceCriteria'] },
    });
    expect(out).toContain('Plan:');
    expect(out).toContain('Acceptance:');
  });

  it('includeFields override narrows below per-state default', () => {
    // Default for `code` is [desc, plan, AC]. Override → only AC.
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: SAMPLE,
      policy: { includeFields: ['acceptanceCriteria'] },
    });
    expect(out).toContain('Acceptance:');
    expect(out).not.toContain('Description:');
    expect(out).not.toContain('Plan:');
  });

  it('fieldCaps override changes truncation threshold', () => {
    const desc = 'x'.repeat(5000);
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: { ...SAMPLE, description: desc },
      policy: { fieldCaps: { description: 1000 } },
    });
    expect(out).toMatch(/\[truncated at \d+\/5000 chars/);
  });

  it('byte-cut strategy skips paragraph search', () => {
    const desc = `${'A'.repeat(900)}\n\n${'B'.repeat(500)}`;
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: { ...SAMPLE, description: desc },
      policy: { fieldCaps: { description: 1000 }, truncationStrategy: 'byte-cut' },
    });
    // Byte-cut cuts at exactly 1000 → marker reports cap=1000
    expect(out).toMatch(/\[truncated at 1000\/\d+ chars/);
  });

  it('sessionContext field override gates which fields render', () => {
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: {
        ...SAMPLE,
        sessionContext: {
          sessionCount: 3,
          decisions: ['used middleware', 'rate-limited'],
          filesModified: ['core/middleware.ts'],
          errorsResolved: ['fixed race condition'],
          reviewFeedback: [],
        },
      },
      // Only decisions
      policy: { sessionContext: { fields: ['decisions'] } },
    });
    expect(out).toContain('**Key decisions:**');
    expect(out).not.toContain('**Files touched:**');
    expect(out).not.toContain('**Errors resolved:**');
  });

  it('sessionContext depth caps how many items appear', () => {
    const decisions = Array.from({ length: 20 }, (_, i) => `decision-${i}`);
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: {
        ...SAMPLE,
        sessionContext: { sessionCount: 5, decisions },
      },
      policy: { sessionContext: { depth: 3 } },
    });
    // Should include the last 3 decisions only
    expect(out).toContain('decision-19');
    expect(out).toContain('decision-18');
    expect(out).toContain('decision-17');
    expect(out).not.toContain('decision-16');
  });
});

describe('buildJobPromptString turn-level system prompt', () => {
  it('injects turn-level rules block when turnLevelSystemPrompt provided', () => {
    const sp = '## Pipeline Rules\n- Status LAST.';
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      turnLevelSystemPrompt: sp,
    });
    expect(out).toContain('## Pipeline Rules (this turn)');
    expect(out).toContain('Status LAST');
  });

  it('skips turn-level block when prompt is empty/whitespace', () => {
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      turnLevelSystemPrompt: '   ',
    });
    expect(out).not.toContain('this turn');
  });

  it('turn-level rules precede ## Issue block', () => {
    const sp = '## Rules\n- A';
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: SAMPLE,
      turnLevelSystemPrompt: sp,
    });
    const tlIdx = out.indexOf('## Pipeline Rules (this turn)');
    const issueIdx = out.indexOf('## Issue');
    expect(tlIdx).toBeGreaterThanOrEqual(0);
    expect(issueIdx).toBeGreaterThan(tlIdx);
  });
});
