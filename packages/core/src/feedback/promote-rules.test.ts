import { describe, expect, it } from 'vitest';
import { promoteRefusal } from './rules.js';

const REPORT = '44444444-4444-4444-8444-444444444444';
const facts = {
  reportId: REPORT,
  reportProject: 'eco-a',
  project: 'eco-a',
  feedbackKey: null,
  linkedIssueKey: null,
};

describe('promoting an agent report (ISS-93)', () => {
  it('lets a report of this project with no route become feedback', () => {
    expect(promoteRefusal(facts)).toBeNull();
  });

  it('a second promotion is FEEDBACK_SOURCE_ALREADY_PROMOTED, pointing at the item it became', () => {
    const r = promoteRefusal({ ...facts, feedbackKey: 'FB-7' });
    expect(r).toMatchObject({ code: 'FEEDBACK_SOURCE_ALREADY_PROMOTED', path: '/agentReport' });
    expect(r?.detail).toContain('open FB-7');
    expect(r?.detail).toContain(REPORT);
  });

  it('a report of another project is FEEDBACK_SOURCE_NOT_IN_PROJECT, naming both projects', () => {
    const r = promoteRefusal({ ...facts, reportProject: 'hop', feedbackKey: 'FB-2' });
    expect(r).toMatchObject({ code: 'FEEDBACK_SOURCE_NOT_IN_PROJECT', path: '/agentReport' });
    expect(r?.detail).toContain('project hop, not eco-a');
  });

  it('a report already curated into an issue is FEEDBACK_SOURCE_ROUTED_ELSEWHERE, naming the issue', () => {
    const r = promoteRefusal({ ...facts, linkedIssueKey: 'ISS-12' });
    expect(r).toMatchObject({ code: 'FEEDBACK_SOURCE_ROUTED_ELSEWHERE', path: '/agentReport' });
    expect(r?.detail).toContain('ISS-12');
  });
});
