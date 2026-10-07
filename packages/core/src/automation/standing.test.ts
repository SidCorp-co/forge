import type { AgentReportView } from '@forge/contracts/agent-reports';
import { needsViewer } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { type ReportFacts, reportStandingOf } from './standing.js';

const view = (over: Partial<AgentReportView> = {}): AgentReportView => ({
  id: 'r1',
  projectId: 'p1',
  projectSlug: 'hop',
  issueId: 'i1',
  runId: null,
  jobId: null,
  stage: null,
  kind: 'bug',
  severity: 'medium',
  target: 'tool',
  targetRef: 'forge record',
  summary: 'forge record verdict refuses every verdict',
  detail: null,
  suggestion: null,
  signalKey: 'self_report:tool:forge record:bug',
  sessionId: null,
  scheduleRunId: null,
  triage: 'new',
  triagedBy: null,
  triagedAt: null,
  triageReason: null,
  duplicateOf: null,
  linkedIssueId: null,
  feedback: null,
  createdAt: '2026-10-06T01:00:00.000Z',
  ...over,
});

const owner = { id: 'u1', name: 'Owner' };
const writer = {
  userId: 'u1',
  canWrite: true,
  isAdmin: true,
  holders: { admins: [], writers: [] },
};

// F9: a report an issue run filed is about the harness it ran under, not the viewer's to-do
describe('whom a new agent report waits on', () => {
  it('a report no fire filed waits on harness triage, never in the viewer’s Needs you', () => {
    const facts: ReportFacts = { view: view(), fire: null, issue: null };
    const s = reportStandingOf(facts, writer);
    expect(needsViewer(s)).toBe(false);
    expect(s.attentionGroup).toBe('waiting');
    expect(s.waitingOn).toMatchObject({
      kind: 'writers',
      who: 'Harness triage',
      act: 'triage a report',
    });
  });

  it('a report a fire filed still waits on its schedule owner, in their Needs you', () => {
    const facts: ReportFacts = {
      view: view({ scheduleRunId: 'f1' }),
      fire: { id: 'f1', scheduleId: 's1', scheduleName: 'Nightly steward', owner },
      issue: null,
    };
    const s = reportStandingOf(facts, writer);
    expect(needsViewer(s)).toBe(true);
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'triage a report' });
  });
});

// H3: a group's wait read "A project writer" whoever held write, and when nobody did
describe('a report whose schedule has no owner', () => {
  const facts: ReportFacts = {
    view: view({ scheduleRunId: 'f1' }),
    fire: { id: 'f1', scheduleId: 's1', scheduleName: 'Nightly steward', owner: null },
    issue: null,
  };
  const reader = (writers: string[]) => ({
    userId: 'u9',
    canWrite: false,
    isAdmin: false,
    holders: { admins: ['Ada'], writers },
  });

  it('names the writers who triage it', () => {
    expect(reportStandingOf(facts, reader(['Ana', 'Bo'])).waitingOn).toMatchObject({
      kind: 'writers',
      who: 'Ana, Bo',
      act: 'triage a report',
    });
  });

  it('says nobody holds write, and where it is granted, when nobody does', () => {
    const w = reportStandingOf(facts, reader([])).waitingOn;
    expect(w).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(w.rule).toContain('no person on this project holds project.write');
  });
});
