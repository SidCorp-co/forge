import { describe, expect, it } from 'vitest';
import {
  LOOKBACK_WINDOW_DAYS,
  MAX_DRAFT_PROPOSALS_PER_RUN,
  STALENESS_AGE_DAYS,
  UNDOCUMENTED_ISSUE_THRESHOLD,
  buildDriftCheckPrompt,
} from './drift-check-prompt.js';

const PROJECT_ID = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';

describe('drift-check constants', () => {
  it('STALENESS_AGE_DAYS is 90', () => {
    expect(STALENESS_AGE_DAYS).toBe(90);
  });

  it('LOOKBACK_WINDOW_DAYS is 30', () => {
    expect(LOOKBACK_WINDOW_DAYS).toBe(30);
  });

  it('UNDOCUMENTED_ISSUE_THRESHOLD is 3', () => {
    expect(UNDOCUMENTED_ISSUE_THRESHOLD).toBe(3);
  });

  it('MAX_DRAFT_PROPOSALS_PER_RUN is 5', () => {
    expect(MAX_DRAFT_PROPOSALS_PER_RUN).toBe(5);
  });
});

describe('buildDriftCheckPrompt', () => {
  const prompt = buildDriftCheckPrompt({ projectId: PROJECT_ID, mode: 'propose' });

  it('returns a non-empty string', () => {
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('embeds the projectId', () => {
    expect(prompt).toContain(PROJECT_ID);
  });

  it('includes the staleness age threshold in text', () => {
    expect(prompt).toContain(String(STALENESS_AGE_DAYS));
  });

  it('includes the lookback window in text', () => {
    expect(prompt).toContain(String(LOOKBACK_WINDOW_DAYS));
  });

  it('includes the undocumented issue threshold in text', () => {
    expect(prompt).toContain(String(UNDOCUMENTED_ISSUE_THRESHOLD));
  });

  it('includes the max draft proposals cap in text', () => {
    expect(prompt).toContain(String(MAX_DRAFT_PROPOSALS_PER_RUN));
  });

  it('describes the stale drift signal', () => {
    expect(prompt.toLowerCase()).toContain('stale');
  });

  it('describes the removed-feature drift signal', () => {
    expect(prompt.toLowerCase()).toContain('removed');
  });

  it('describes the undocumented drift signal', () => {
    expect(prompt.toLowerCase()).toContain('undocumented');
  });

  it('instructs the agent to create draft issues with status=draft', () => {
    expect(prompt).toContain('"draft"');
    expect(prompt.toLowerCase()).toContain('draft issue');
  });

  it('prohibits forge_knowledge upsert and delete', () => {
    expect(prompt).toContain('NEVER call `forge_knowledge action=upsert`');
    expect(prompt).toContain('forge_knowledge action=delete');
  });

  it('prohibits injection=always', () => {
    expect(prompt).toContain('"always"');
    expect(prompt.toLowerCase()).toMatch(/never.*always|always.*never/);
  });

  it('instructs propose-only (no direct knowledge_entries edits)', () => {
    expect(prompt.toLowerCase()).toContain('propose');
    expect(prompt.toLowerCase()).toContain('never edit knowledge_entries directly');
  });

  it('does not reference the steward report sentinel', () => {
    expect(prompt).not.toContain('STEWARD_RUN_REPORT_JSON');
  });
});
