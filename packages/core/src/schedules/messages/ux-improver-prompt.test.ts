import { describe, expect, it } from 'vitest';
import { getImprovementMessage } from './registry.js';
import { buildUxImproverPrompt, MAX_PROPOSALS_PER_RUN } from './ux-improver-prompt.js';

const PROJECT_ID = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';

describe('buildUxImproverPrompt', () => {
  const prompt = buildUxImproverPrompt({ projectId: PROJECT_ID, mode: 'propose' });

  it('embeds the projectId the agent must query', () => {
    expect(prompt).toContain(PROJECT_ID);
  });

  it('routes the agent through both improver actions, read before write', () => {
    expect(prompt.indexOf('action="candidates"')).toBeGreaterThan(-1);
    expect(prompt.indexOf('action="propose"')).toBeGreaterThan(
      prompt.indexOf('action="candidates"'),
    );
  });

  it('caps how many candidates one run may commit, and states the cap in the prompt', () => {
    expect(prompt).toContain(String(MAX_PROPOSALS_PER_RUN));
    expect(prompt).toMatch(/at most \d+ per run/);
  });

  it('requires the run to name what it dropped to the cap, so a cap reads differently from a judgment', () => {
    expect(prompt).toContain('name the ones you dropped');
  });

  it('tells the agent to read the refusals, not only the candidates', () => {
    expect(prompt).toContain('refused');
    expect(prompt).toContain('quiet project');
  });

  it('forbids activating a rule in BOTH modes — auto must not become auto-apply', () => {
    const auto = buildUxImproverPrompt({ projectId: PROJECT_ID, mode: 'auto' });
    for (const p of [prompt, auto]) {
      expect(p).toContain('you may not set a rule to `active`');
      expect(p).toContain('never activate a rule');
    }
  });

  it('warns that the inbox has no edit box, so proposal wording has to stand on its own', () => {
    expect(prompt).toContain('approve and reject only');
  });

  it('tells the agent to stop rather than lower a bar when nothing recurs', () => {
    expect(prompt).toContain('Do not lower any bar');
  });
});

describe('ux-contract-improve registry entry', () => {
  const entry = getImprovementMessage('ux-contract-improve');

  it('is registered as a standing template so every cadence tick re-reads the findings', () => {
    expect(entry).toBeDefined();
    expect(entry?.standing).toBe(true);
  });

  it('defaults to propose mode — the epic locked propose-only', () => {
    expect(entry?.defaultMode).toBe('propose');
  });

  it('declares the condition under which it applies at all', () => {
    expect(entry?.appliesWhen).toContain('ux_findings');
  });
});
