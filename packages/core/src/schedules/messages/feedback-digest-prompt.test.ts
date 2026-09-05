import { describe, expect, it } from 'vitest';
import {
  buildFeedbackDigestPrompt,
  DIGEST_DETECTOR_KEY,
  FEEDBACK_LIST_LIMIT,
  MAX_CLUSTERS_PER_DIGEST,
  MAX_DIGEST_ISSUES_PER_RUN,
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

  it('DIGEST_DETECTOR_KEY is the fixed fleet-backlog key', () => {
    expect(DIGEST_DETECTOR_KEY).toBe('feedback-digest/fleet-backlog');
  });

  it('DIGEST_DETECTOR_KEY carries no date or window, so it cannot drift per run', () => {
    expect(DIGEST_DETECTOR_KEY).not.toMatch(/\d/);
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

  it('puts the detectorKey inside the create call the agent copies, not merely in the prose', () => {
    const open = prompt.indexOf('forge_issues.create({');
    expect(open).toBeGreaterThan(-1);
    const createBlock = prompt.slice(open, prompt.indexOf('})', open));
    expect(createBlock).toContain(`detectorKey: "${DIGEST_DETECTOR_KEY}"`);
  });

  it('tells the agent to comment on the existing issue when the create is deduped', () => {
    expect(prompt).toContain('deduped:true');
    expect(prompt).toContain('existingIssueId');
    expect(prompt).toContain('forge_comments action=create');
  });

  it('forbids minting a variant key to dodge the dedupe', () => {
    expect(prompt.toLowerCase()).toContain('do not mint a variant key');
  });

  it('tells the agent to enumerate past the size cap rather than trust one call', () => {
    expect(prompt).toContain('hasMore:false');
    expect(prompt.toLowerCase()).toContain('one call is not the backlog');
  });

  it('names every filter dimension the enumeration narrows by, in order', () => {
    const step1 = prompt.slice(prompt.indexOf('## STEP 1'), prompt.indexOf('## STEP 2'));
    for (const dimension of ['`target`', '`severity`', '`kind`', '`projectId`']) {
      expect(step1).toContain(dimension);
    }
  });

  it('requires the total be reported as a floor, not a count', () => {
    expect(prompt).toMatch(/FLOOR \(`≥N`\), never a count/);
  });

  it('no longer carries the prose dedupe rule the detectorKey replaced', () => {
    expect(prompt).not.toContain('overlapping report set');
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
