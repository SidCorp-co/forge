import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { agentReports } from './schema.js';

describe('agentReports table (ISS-552 C1)', () => {
  it('is the agent_reports table, leaving the word feedback to product feedback', () => {
    expect(getTableConfig(agentReports).name).toBe('agent_reports');
  });

  it('has the expected columns', () => {
    const names = getTableConfig(agentReports)
      .columns.map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'id',
        'project_id',
        'issue_id',
        'run_id',
        'job_id',
        'stage',
        'skill_name',
        'skill_version',
        'kind',
        'severity',
        'target',
        'target_ref',
        'summary',
        'detail',
        'suggestion',
        'signal_key',
        'session_id',
        'schedule_run_id',
        'triage',
        'triaged_by',
        'triaged_agency',
        'triaged_at',
        'triage_reason',
        'duplicate_of',
        'linked_issue_id',
        'feedback_id',
        'created_at',
      ].sort(),
    );
  });

  it('project_id cascades on delete', () => {
    const cfg = getTableConfig(agentReports);
    const fk = cfg.foreignKeys.find((k) =>
      k.reference().columns.some((c) => c.name === 'project_id'),
    );
    if (!fk) throw new Error('project_id FK not found');
    expect(fk.onDelete).toBe('cascade');
  });

  it('issue_id, run_id, job_id are nullable (set null on delete)', () => {
    const cfg = getTableConfig(agentReports);
    const cols = cfg.columns;
    const issueId = cols.find((c) => c.name === 'issue_id');
    const runId = cols.find((c) => c.name === 'run_id');
    const jobId = cols.find((c) => c.name === 'job_id');
    if (!issueId || !runId || !jobId) throw new Error('nullable FK column not found');
    expect(issueId.notNull).toBe(false);
    expect(runId.notNull).toBe(false);
    expect(jobId.notNull).toBe(false);
  });

  it('severity defaults to "low"', () => {
    const col = getTableConfig(agentReports).columns.find((c) => c.name === 'severity');
    if (!col) throw new Error('severity column not found');
    expect(col.default).toBe('low');
  });

  it('has the expected indexes (ISS-557 adds session_id_idx)', () => {
    const names = getTableConfig(agentReports).indexes.map((i) => i.config.name);
    expect(names).toContain('agent_reports_project_id_idx');
    expect(names).toContain('agent_reports_project_kind_idx');
    expect(names).toContain('agent_reports_project_target_idx');
    expect(names).toContain('agent_reports_signal_key_idx');
    expect(names).toContain('agent_reports_created_at_idx');
    expect(names).toContain('agent_reports_session_id_idx');
    expect(names).toContain('agent_reports_linked_issue_id_idx');
    expect(names).toContain('agent_reports_project_triage_idx');
    expect(names).toContain('agent_reports_schedule_run_idx');
  });

  it('triage defaults to new (ISS-113)', () => {
    const col = getTableConfig(agentReports).columns.find((c) => c.name === 'triage');
    if (!col) throw new Error('triage column not found');
    expect(col.default).toBe('new');
    expect(col.notNull).toBe(true);
  });
});
