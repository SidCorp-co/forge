import { describe, expect, it } from 'vitest';
import {
  SKILL_IMPROVE_REPORT_SENTINEL,
  buildSkillImprovePrompt,
  extractReportFromMessages,
  parseSkillImproveReport,
} from './skill-improve-prompt.js';

// ── buildSkillImprovePrompt ───────────────────────────────────────────────────

describe('buildSkillImprovePrompt', () => {
  it('returns null for unknown templateKey', () => {
    const result = buildSkillImprovePrompt({
      templateKey: 'non-existent-key',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(result).toBeNull();
  });

  it('includes message text, rationale, and appliesWhen in the prompt', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('merged-at-on-pass');
    expect(prompt).toContain('forge_issues.mark_merged');
    expect(prompt).toContain('blocks/decomposes');
    // appliesWhen should be included
    expect(prompt).toContain('base-merge state');
  });

  it('includes the 4-source context reading instructions', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    // a) skills
    expect(prompt).toContain('forge_skills.list');
    // b) knowledge.json
    expect(prompt).toContain('.forge/knowledge.json');
    // c) memory
    expect(prompt).toContain('forge_memory_search');
    // d) pipeline runs
    expect(prompt).toContain('forge_project_pipeline_runs');
  });

  it('propose mode — instructs agent to create draft issue, not update skill directly', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('draft');
    expect(prompt).toContain('forge_issues.create');
    expect(prompt).not.toContain('forge_skills.update');
  });

  it('auto mode — instructs agent to call forge_skills.update directly', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'auto',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('forge_skills.update');
  });

  it('includes the sentinel instruction', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(SKILL_IMPROVE_REPORT_SENTINEL);
  });

  it('idempotency: returns null when applied version === registry version', () => {
    const result = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      // registry version is 1
      appliedMessageVersions: { 'merged-at-on-pass': 1 },
    });
    expect(result).toBeNull();
  });

  it('idempotency: returns null when applied version > registry version', () => {
    const result = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: { 'merged-at-on-pass': 99 },
    });
    expect(result).toBeNull();
  });

  it('idempotency: builds prompt when applied version < registry version', () => {
    const result = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: { 'merged-at-on-pass': 0 },
    });
    expect(result).not.toBeNull();
  });

  it('idempotency: builds prompt when key is absent from appliedVersions', () => {
    const result = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: { 'some-other-key': 5 },
    });
    expect(result).not.toBeNull();
  });

  it('idempotency: builds prompt when appliedMessageVersions is null', () => {
    const result = buildSkillImprovePrompt({
      templateKey: 'merged-at-on-pass',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(result).not.toBeNull();
  });

  // ── Synthetic project context divergence examples ─────────────────────────
  // These show what the AGENT would receive for each seed message / project type.

  it('release-conflict-2tier — prompt mentions 2-branch condition', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'release-conflict-2tier',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('release-conflict-2tier');
    expect(prompt).toContain('baseBranch');
    // appliesWhen condition text should be embedded
    expect(prompt).toContain('productionBranch');
  });

  it('qa-quality-bar — prompt mentions FE/UI condition', () => {
    const prompt = buildSkillImprovePrompt({
      templateKey: 'qa-quality-bar',
      mode: 'propose',
      appliedMessageVersions: null,
    });
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('qa-quality-bar');
    // appliesWhen references FE/UI
    expect(prompt).toContain('frontend');
  });

  it('all 3 seed messages produce non-null prompts with no applied versions', () => {
    for (const key of ['merged-at-on-pass', 'release-conflict-2tier', 'qa-quality-bar']) {
      const result = buildSkillImprovePrompt({
        templateKey: key,
        mode: 'propose',
        appliedMessageVersions: null,
      });
      expect(result, `prompt for ${key} should not be null`).not.toBeNull();
    }
  });
});

// ── parseSkillImproveReport ───────────────────────────────────────────────────

describe('parseSkillImproveReport', () => {
  it('returns null when sentinel is absent', () => {
    expect(parseSkillImproveReport('no sentinel here')).toBeNull();
    expect(parseSkillImproveReport('')).toBeNull();
  });

  it('parses an "applied" report', () => {
    const text = `Done.\n${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"merged-at-on-pass","version":1,"status":"applied"}`;
    const result = parseSkillImproveReport(text);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0]).toMatchObject({
      key: 'merged-at-on-pass',
      version: 1,
      status: 'applied',
    });
    expect(result!.updatedVersions).toEqual({ 'merged-at-on-pass': 1 });
  });

  it('parses a "proposed" report', () => {
    const text = `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"qa-quality-bar","version":1,"status":"proposed"}`;
    const result = parseSkillImproveReport(text);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.status).toBe('proposed');
    expect(result!.updatedVersions).toEqual({ 'qa-quality-bar': 1 });
  });

  it('parses a "skipped" report with reason', () => {
    const text = `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"release-conflict-2tier","version":1,"status":"skipped","reason":"project uses single-branch workflow"}`;
    const result = parseSkillImproveReport(text);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.status).toBe('skipped');
    expect(result!.entries[0]!.reason).toBe('project uses single-branch workflow');
    // skipped must NOT populate updatedVersions
    expect(result!.updatedVersions).toEqual({});
  });

  it('skipped does NOT update applied versions (so later config change re-triggers)', () => {
    const text = `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"merged-at-on-pass","version":1,"status":"skipped","reason":"no blocks edges in use"}`;
    const result = parseSkillImproveReport(text);
    expect(result!.updatedVersions).toEqual({});
  });

  it('returns null for malformed JSON after sentinel', () => {
    const text = `${SKILL_IMPROVE_REPORT_SENTINEL}\nnot-json`;
    expect(parseSkillImproveReport(text)).toBeNull();
  });

  it('returns null when JSON is missing required fields', () => {
    const text = `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"k","version":1}`;
    expect(parseSkillImproveReport(text)).toBeNull();
  });

  it('finds sentinel embedded anywhere in the text', () => {
    const text = `Agent output line 1\nLine 2\n${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"merged-at-on-pass","version":1,"status":"applied"}`;
    const result = parseSkillImproveReport(text);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.key).toBe('merged-at-on-pass');
  });
});

// ── extractReportFromMessages ─────────────────────────────────────────────────

describe('extractReportFromMessages', () => {
  it('returns null for empty message array', () => {
    expect(extractReportFromMessages([])).toBeNull();
  });

  it('ignores non-assistant messages', () => {
    const messages = [
      { role: 'user', content: `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"k","version":1,"status":"applied"}` },
    ];
    expect(extractReportFromMessages(messages)).toBeNull();
  });

  it('finds report in assistant string content', () => {
    const messages = [
      { role: 'user', content: 'trigger' },
      {
        role: 'assistant',
        content: `All done.\n${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"merged-at-on-pass","version":1,"status":"proposed"}`,
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.status).toBe('proposed');
  });

  it('finds report in assistant multi-block content array', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Thinking...' },
          {
            type: 'text',
            text: `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"qa-quality-bar","version":1,"status":"applied"}`,
          },
        ],
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.key).toBe('qa-quality-bar');
  });

  it('scans from the end — uses last sentinel if multiple present', () => {
    const messages = [
      {
        role: 'assistant',
        content: `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"merged-at-on-pass","version":1,"status":"skipped","reason":"early"}`,
      },
      {
        role: 'assistant',
        content: `${SKILL_IMPROVE_REPORT_SENTINEL}\n{"key":"merged-at-on-pass","version":1,"status":"applied"}`,
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.status).toBe('applied');
  });

  it('returns null when no assistant message contains the sentinel', () => {
    const messages = [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: 'I will do this.' },
      { role: 'tool', content: 'tool result' },
    ];
    expect(extractReportFromMessages(messages)).toBeNull();
  });

  // ── Integration: divergent outcomes across project configs ────────────────
  // These verify that different project configs produce different report outcomes.
  // In the real engine the agent evaluates appliesWhen at runtime; here we
  // verify the report parser handles all outcome variants correctly.

  it('project with 2-branch workflow: "proposed" report records version', () => {
    const messages = [
      {
        role: 'assistant',
        content: `I evaluated release-conflict-2tier against this 2-branch project.\n` +
          `baseBranch=main, productionBranch=release — condition met.\n` +
          `Created draft issue ISS-999.\n` +
          `${SKILL_IMPROVE_REPORT_SENTINEL}\n` +
          `{"key":"release-conflict-2tier","version":1,"status":"proposed"}`,
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result!.updatedVersions).toEqual({ 'release-conflict-2tier': 1 });
  });

  it('single-branch project: "skipped" report does NOT record version', () => {
    const messages = [
      {
        role: 'assistant',
        content: `Evaluated release-conflict-2tier.\n` +
          `baseBranch=main === productionBranch=main — single-branch, condition not met.\n` +
          `${SKILL_IMPROVE_REPORT_SENTINEL}\n` +
          `{"key":"release-conflict-2tier","version":1,"status":"skipped","reason":"baseBranch equals productionBranch — single-branch project"}`,
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result!.entries[0]!.status).toBe('skipped');
    expect(result!.updatedVersions).toEqual({});
  });

  it('project with FE: qa-quality-bar "proposed"', () => {
    const messages = [
      {
        role: 'assistant',
        content: `Project has web app. Condition met.\n` +
          `${SKILL_IMPROVE_REPORT_SENTINEL}\n` +
          `{"key":"qa-quality-bar","version":1,"status":"proposed"}`,
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result!.entries[0]!.status).toBe('proposed');
    expect(result!.updatedVersions).toEqual({ 'qa-quality-bar': 1 });
  });

  it('backend-only project: qa-quality-bar "skipped"', () => {
    const messages = [
      {
        role: 'assistant',
        content: `No frontend surface found. Condition not met.\n` +
          `${SKILL_IMPROVE_REPORT_SENTINEL}\n` +
          `{"key":"qa-quality-bar","version":1,"status":"skipped","reason":"project has no frontend/UI surface — backend-only service"}`,
      },
    ];
    const result = extractReportFromMessages(messages);
    expect(result!.entries[0]!.reason).toBe(
      'project has no frontend/UI surface — backend-only service',
    );
    expect(result!.updatedVersions).toEqual({});
  });
});
