import { describe, expect, it } from 'vitest';
import { type IssueSnapshot, buildJobPromptString, injectTurnLevelRules } from './user.js';

const SAMPLE: IssueSnapshot = {
  title: 'Add rate limiting',
  description: 'Throttle endpoints',
  plan: '1. Add middleware\n2. Wire routes',
  acceptanceCriteria: '- [ ] 429 returned',
  sessionContext: null,
};

describe('buildJobPromptString thin-prompt default (fetch-via-tool)', () => {
  it('inlines NO issue body fields by default for every stage; carries a forge_step_start pointer', () => {
    for (const jobType of ['triage', 'clarify', 'plan', 'code', 'review', 'test', 'fix'] as const) {
      const out = buildJobPromptString({ jobType, issueId: 'iss-1', issueSnapshot: SAMPLE });
      expect(out, jobType).not.toContain('Description:');
      expect(out, jobType).not.toContain('Plan:');
      expect(out, jobType).not.toContain('Acceptance:');
      // Title still orients the agent; the pointer tells it where the rest lives.
      expect(out, jobType).toContain('Title: Add rate limiting');
      expect(out, jobType).toContain('forge_step_start');
    }
  });
});

describe('buildJobPromptString policy overrides', () => {
  it('includeFields override re-inlines fields above the empty default', () => {
    // Default is now [] for every state. Override opts description+plan+AC back in.
    const out = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: SAMPLE,
      policy: { includeFields: ['description', 'plan', 'acceptanceCriteria'] },
    });
    expect(out).toContain('Description:');
    expect(out).toContain('Plan:');
    expect(out).toContain('Acceptance:');
  });

  it('includeFields override can re-inline a single field only', () => {
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

  it('fieldCaps override changes truncation threshold (with field re-inlined)', () => {
    const desc = 'x'.repeat(5000);
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: { ...SAMPLE, description: desc },
      policy: { includeFields: ['description'], fieldCaps: { description: 1000 } },
    });
    expect(out).toMatch(/\[truncated at \d+\/5000 chars/);
  });

  it('byte-cut strategy skips paragraph search (with field re-inlined)', () => {
    const desc = `${'A'.repeat(900)}\n\n${'B'.repeat(500)}`;
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: { ...SAMPLE, description: desc },
      policy: {
        includeFields: ['description'],
        fieldCaps: { description: 1000 },
        truncationStrategy: 'byte-cut',
      },
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
      policy: { sessionContext: { fields: ['decisions'], depth: 3 } },
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

describe('injectTurnLevelRules', () => {
  it('returns input unchanged when turnLevelSystemPrompt is empty/null/undefined', () => {
    const base = '/forge-code iss-1\n\n## Issue\nTitle: Hello';
    expect(injectTurnLevelRules(base, null)).toBe(base);
    expect(injectTurnLevelRules(base, undefined)).toBe(base);
    expect(injectTurnLevelRules(base, '')).toBe(base);
    expect(injectTurnLevelRules(base, '   \n  ')).toBe(base);
  });

  it('inserts a rules block immediately after the first line', () => {
    const base = '/forge-code iss-1\n\n## Issue\nTitle: Hello';
    const out = injectTurnLevelRules(base, '## Rules\n- A');
    // Format: skill line, then injected block, then existing remainder.
    const skillLine = '/forge-code iss-1';
    expect(out.startsWith(skillLine)).toBe(true);
    const tlIdx = out.indexOf('## Pipeline Rules (this turn)');
    const issueIdx = out.indexOf('## Issue');
    expect(tlIdx).toBeGreaterThan(skillLine.length);
    expect(issueIdx).toBeGreaterThan(tlIdx);
    expect(out).toContain('## Rules\n- A');
  });

  it('appends rules block when the input is a single line (no \\n)', () => {
    const out = injectTurnLevelRules('/forge-code iss-1', '## Rules\n- A');
    expect(out.startsWith('/forge-code iss-1')).toBe(true);
    expect(out).toContain('## Pipeline Rules (this turn)');
    expect(out).toContain('## Rules');
  });
});

describe('buildJobPromptString — step-handoff (proposal Y)', () => {
  const snapshot: IssueSnapshot = {
    title: 'Login broken on Safari',
    description: 'Users on iOS Safari cannot complete login',
    plan: 'Investigate cookie SameSite + ITP',
    acceptanceCriteria: 'Login succeeds on Safari 17+',
  };

  it('renders ## Prior step handoffs when policy.handoffs.enabled and priorHandoffs supplied', () => {
    const out = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: {
        handoffs: { enabled: true, injectFromSteps: ['triage'] },
      },
      priorHandoffs: [
        {
          step: 'triage',
          payload: {
            step: 'triage',
            schema_version: 1,
            summary: 'Safari ITP blocks JWT cookie',
            suggestedApproach: 'Add SameSite=None; Secure fallback',
            complexity: 'm',
            risks: ['session loss on existing iOS users'],
            affectedAreas: ['auth/cookie'],
          },
        },
      ],
    });
    expect(out).toContain('## Prior step handoffs');
    expect(out).toContain('### triage');
    expect(out).toContain('"summary": "Safari ITP blocks JWT cookie"');
  });

  it('drops raw `description` when a triage handoff is injected (saves prompt tokens)', () => {
    const out = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: {
        includeFields: ['description'],
        handoffs: { enabled: true, injectFromSteps: ['triage'] },
      },
      priorHandoffs: [
        {
          step: 'triage',
          payload: {
            step: 'triage',
            schema_version: 1,
            summary: 's',
            suggestedApproach: 'a',
            complexity: 'm',
            risks: [],
            affectedAreas: [],
          },
        },
      ],
    });
    expect(out).not.toContain('Description:');
    expect(out).not.toContain('Users on iOS Safari');
  });

  it('drops raw `plan` when a plan handoff is injected', () => {
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: {
        includeFields: ['description', 'plan', 'acceptanceCriteria'],
        handoffs: { enabled: true, injectFromSteps: ['triage', 'plan'] },
      },
      priorHandoffs: [
        {
          step: 'plan',
          payload: {
            step: 'plan',
            schema_version: 1,
            planSummary: 'Add SameSite fallback',
            affectedFiles: ['src/auth/cookie.ts'],
            acceptanceChecklist: ['safari login passes'],
            unknowns: [],
          },
        },
      ],
    });
    expect(out).not.toContain('Plan:');
    expect(out).not.toContain('Investigate cookie SameSite');
  });

  it('keeps re-inlined raw fields when priorHandoffs is empty (rollout-safe fallback)', () => {
    // With description re-inlined via includeFields, an enabled-but-empty
    // handoff set still falls back to the raw field (not skipped).
    const out = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: {
        includeFields: ['description'],
        handoffs: { enabled: true, injectFromSteps: ['triage'] },
      },
      priorHandoffs: [],
    });
    expect(out).toContain('Description:');
    expect(out).toContain('Users on iOS Safari');
  });

  it('filters priorHandoffs to policy.injectFromSteps allow-list', () => {
    // Caller supplied triage + plan, policy only whitelists triage.
    const out = buildJobPromptString({
      jobType: 'code',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: { handoffs: { enabled: true, injectFromSteps: ['triage'] } },
      priorHandoffs: [
        {
          step: 'triage',
          payload: {
            step: 'triage',
            schema_version: 1,
            summary: 't',
            suggestedApproach: 'a',
            complexity: 's',
            risks: [],
            affectedAreas: [],
          },
        },
        {
          step: 'plan',
          payload: {
            step: 'plan',
            schema_version: 1,
            planSummary: 'p',
            affectedFiles: [],
            acceptanceChecklist: [],
            unknowns: [],
          },
        },
      ],
    });
    expect(out).toContain('### triage');
    expect(out).not.toContain('### plan');
  });

  it('appends ## Termination protocol when handoffs.enabled + handoffScope + handoff step', () => {
    const out = buildJobPromptString({
      jobType: 'triage',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: { handoffs: { enabled: true, injectFromSteps: [] } },
      handoffScope: { projectId: 'p-1', issueId: 'iss-1', runId: 'r-1', attempt: 1 },
    });
    expect(out).toContain('## Termination protocol');
    expect(out).toContain('"projectId": "p-1"');
    expect(out).toContain('"issueId": "iss-1"');
    expect(out).toContain('"pipelineRunId": "r-1"');
    expect(out).toContain('"step": "triage"');
    expect(out).toContain('forge_step_handoff.write');
    expect(out).toContain('DONE');
  });

  it('omits ## Termination protocol for non-handoff steps (release/pm)', () => {
    const out = buildJobPromptString({
      jobType: 'release',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: { handoffs: { enabled: true, injectFromSteps: [] } },
      handoffScope: { projectId: 'p-1', issueId: 'iss-1', runId: 'r-1', attempt: 1 },
    });
    expect(out).not.toContain('## Termination protocol');
  });

  it('omits ## Termination protocol when handoffs.enabled=false even for handoff steps', () => {
    const out = buildJobPromptString({
      jobType: 'plan',
      issueId: 'iss-1',
      issueSnapshot: snapshot,
      policy: { handoffs: { enabled: false, injectFromSteps: [] } },
      handoffScope: { projectId: 'p-1', issueId: 'iss-1', runId: 'r-1', attempt: 1 },
    });
    expect(out).not.toContain('## Termination protocol');
  });
});
