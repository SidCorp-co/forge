import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_LIST_LIMIT,
  MAX_CLUSTERS_PER_DIGEST,
  MAX_DIGEST_ISSUES_PER_RUN,
  buildFeedbackDigestPrompt,
} from './feedback-digest-prompt.js';

const PROJECT_ID = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';

describe('feedback-digest constants', () => {
  it('MAX_DIGEST_ISSUES_PER_RUN is 1', () => {
    expect(MAX_DIGEST_ISSUES_PER_RUN).toBe(1);
  });

  it('MAX_CLUSTERS_PER_DIGEST is 10', () => {
    expect(MAX_CLUSTERS_PER_DIGEST).toBe(10);
  });

  it('FEEDBACK_LIST_LIMIT is 200', () => {
    expect(FEEDBACK_LIST_LIMIT).toBe(200);
  });
});

describe('buildFeedbackDigestPrompt', () => {
  const prompt = buildFeedbackDigestPrompt({ projectId: PROJECT_ID, mode: 'propose' });

  it('returns a non-empty string', () => {
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('embeds the projectId', () => {
    expect(prompt).toContain(PROJECT_ID);
  });

  it('instructs scope=all fleet-wide feedback lookup', () => {
    expect(prompt).toContain('scope="all"');
    expect(prompt).toContain('filters.reviewed=false');
  });

  it('includes the feedback list limit in text', () => {
    expect(prompt).toContain(String(FEEDBACK_LIST_LIMIT));
  });

  it('describes grouping by target then severity', () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('target');
    expect(lower).toContain('severity');
    expect(lower).toMatch(/group.*target.*severity|target.*then.*severity/);
  });

  it('includes the max digest issues cap in text', () => {
    expect(prompt).toContain(String(MAX_DIGEST_ISSUES_PER_RUN));
  });

  it('includes the max clusters cap in text', () => {
    expect(prompt).toContain(String(MAX_CLUSTERS_PER_DIGEST));
  });

  it('instructs the agent to create draft issues with status=draft', () => {
    expect(prompt).toContain('"draft"');
    expect(prompt.toLowerCase()).toContain('draft issue');
  });

  it('prohibits forge_feedback action=review', () => {
    expect(prompt).toContain('NEVER call `forge_feedback action=review`');
  });

  it('prohibits filing at status=open', () => {
    expect(prompt.toLowerCase()).toContain('never create the digest issue at `status="open"`');
  });

  it('instructs propose-only (never reviews reports itself)', () => {
    expect(prompt.toLowerCase()).toContain('propose-only');
    expect(prompt.toLowerCase()).toContain('you never review or edit feedback reports yourself');
  });

  it('does not reference the steward report sentinel', () => {
    expect(prompt).not.toContain('STEWARD_RUN_REPORT_JSON');
  });
});
