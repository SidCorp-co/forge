import { describe, expect, it } from 'vitest';
import {
  STEWARD_RUN_REPORT_SENTINEL,
  buildSkillStewardPrompt,
  extractStewardReportFromMessages,
  parseStewardRunReport,
  type StewardRunReport,
} from './skill-steward-prompt.js';

// ── Prompt builder ────────────────────────────────────────────────────────────

describe('buildSkillStewardPrompt', () => {
  it('always returns a non-null string', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains the 2k-curate mandate', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('2000 tokens');
    expect(prompt).toContain('curate');
  });

  it('contains the per-skill namespace convention', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('steward/<skillName>/');
    expect(prompt).toContain('steward/');
  });

  it('contains propose-via-draft-issue instruction', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('forge_issues.create');
    expect(prompt).toContain('draft');
  });

  it('contains forge_feedback routing for Forge-level issues', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('forge_feedback');
    expect(prompt).toContain('action=submit');
  });

  it('contains the accept-standard bound guardrail', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('ACCEPT-STANDARD RAISE GUARDRAIL');
    expect(prompt).toContain('ONE accept-standard tightening per run');
    expect(prompt).toContain('25%');
  });

  it('contains idempotency check instruction', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('IDEMPOTENCY CHECK');
    expect(prompt).toContain('DO NOT re-propose or re-apply');
  });

  it('contains the 3 retired strategy inputs', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('merged-at-on-pass');
    expect(prompt).toContain('release-conflict-2tier');
    expect(prompt).toContain('qa-quality-bar');
  });

  it('emits the steward sentinel in the prompt', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain(STEWARD_RUN_REPORT_SENTINEL);
  });

  it('includes auto mode instruction when mode=auto', () => {
    const prompt = buildSkillStewardPrompt({ mode: 'auto', projectId: 'proj-1' });
    expect(prompt).toContain('forge_skills.update');
  });

  it('AC4: prompt mandates get-sum-curate when namespace exceeds 2k', () => {
    // The prompt must explicitly instruct the agent to:
    // 1. Get all namespace entries
    // 2. Sum their token estimates
    // 3. Curate before writing if total > 2000
    const prompt = buildSkillStewardPrompt({ mode: 'propose', projectId: 'proj-1' });
    expect(prompt).toContain('Estimate total tokens');
    expect(prompt).toContain('sum of');
    expect(prompt).toContain('YOU MUST CURATE before writing');
  });
});

// ── Report parser ─────────────────────────────────────────────────────────────

const SAMPLE_REPORT: StewardRunReport = {
  weakestDomain: 'plan-quality',
  skillsAssessed: ['forge-plan', 'forge-test'],
  actions: [
    { skill: 'forge-plan', kind: 'proposed', summary: 'Add file-level specificity requirement' },
    { skill: 'forge-test', kind: 'skipped', summary: 'No new signals this run' },
  ],
  memoryWrites: [
    { skill: 'forge-plan', sourceRef: 'steward/forge-plan/specificity', tokensAfter: 320 },
  ],
  idempotencySkips: ['forge-test: pass-b already proposed 2026-06-20'],
};

function buildReportText(report: StewardRunReport): string {
  return `Some output text.\n${STEWARD_RUN_REPORT_SENTINEL}\n${JSON.stringify(report)}\n`;
}

describe('parseStewardRunReport', () => {
  it('round-trips a valid report', () => {
    const text = buildReportText(SAMPLE_REPORT);
    const result = parseStewardRunReport(text);
    expect(result).toBeDefined();
    expect(result?.weakestDomain).toBe('plan-quality');
    expect(result?.skillsAssessed).toEqual(['forge-plan', 'forge-test']);
    expect(result?.actions).toHaveLength(2);
    expect(result?.memoryWrites).toHaveLength(1);
    expect(result?.idempotencySkips).toHaveLength(1);
  });

  it('returns null when no sentinel present', () => {
    expect(parseStewardRunReport('no sentinel here')).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    expect(parseStewardRunReport(`${STEWARD_RUN_REPORT_SENTINEL}\n{bad json}`)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const bad = JSON.stringify({ weakestDomain: 'test' });
    expect(parseStewardRunReport(`${STEWARD_RUN_REPORT_SENTINEL}\n${bad}`)).toBeNull();
  });
});

// ── Message extractor ─────────────────────────────────────────────────────────

describe('extractStewardReportFromMessages', () => {
  it('returns null for empty messages array', () => {
    expect(extractStewardReportFromMessages([])).toBeNull();
  });

  it('finds report in string content', () => {
    const messages = [
      { role: 'user', content: 'Run the steward.' },
      { role: 'assistant', content: buildReportText(SAMPLE_REPORT) },
    ];
    const result = extractStewardReportFromMessages(messages);
    expect(result).toBeDefined();
    expect(result?.weakestDomain).toBe('plan-quality');
  });

  it('finds report in multi-block content array', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Some analysis.\n' },
          { type: 'text', text: buildReportText(SAMPLE_REPORT) },
        ],
      },
    ];
    const result = extractStewardReportFromMessages(messages);
    expect(result).toBeDefined();
    expect(result?.skillsAssessed).toEqual(['forge-plan', 'forge-test']);
  });

  it('scans from end — picks last valid report', () => {
    const report2: StewardRunReport = {
      ...SAMPLE_REPORT,
      weakestDomain: 'review-rigor',
    };
    const messages = [
      { role: 'assistant', content: buildReportText(SAMPLE_REPORT) },
      { role: 'assistant', content: buildReportText(report2) },
    ];
    const result = extractStewardReportFromMessages(messages);
    expect(result?.weakestDomain).toBe('review-rigor');
  });

  it('skips non-assistant messages', () => {
    const messages = [
      { role: 'user', content: buildReportText(SAMPLE_REPORT) },
    ];
    expect(extractStewardReportFromMessages(messages)).toBeNull();
  });

  it('returns null when no report in any message', () => {
    const messages = [
      { role: 'assistant', content: 'I assessed the skills.' },
      { role: 'assistant', content: 'No report emitted.' },
    ];
    expect(extractStewardReportFromMessages(messages)).toBeNull();
  });
});
