import { describe, expect, it } from 'vitest';
import {
  FINALIZE_REPAIR_ENV,
  finalizeRepairMax,
  RETENTION_RULES,
  resolvedWindowDaysFor,
  resolveRetention,
  retentionRuleFor,
} from './policy.js';

const ruleFor = (table: string) => {
  const rule = retentionRuleFor(table);
  if (!rule) throw new Error(`no rule stated for ${table}`);
  return rule;
};

describe('retention policy: the stated rules', () => {
  it('states a rule for every table ISS-1027 names, swept or not', () => {
    const tables = RETENTION_RULES.map((r) => r.table);
    expect(tables).toEqual(
      expect.arrayContaining([
        'job_events',
        'queue_snapshots',
        'runner_events',
        'kernel_transitions',
        'retrieval_analytics',
        'mcp_audit_log',
        'agent_session_turns',
      ]),
    );
  });

  it('gives every rule a reason, so a window is never a bare number', () => {
    for (const rule of RETENTION_RULES) {
      expect(rule.why.length).toBeGreaterThan(40);
    }
  });

  it('gives every windowed rule an environment variable and a floor at or below its window', () => {
    for (const rule of RETENTION_RULES) {
      if (rule.days === null) continue;
      expect(rule.env).toMatch(/^RETENTION_[A-Z_]+_DAYS$/);
      expect(rule.floorDays).toBeGreaterThan(0);
      expect(rule.floorDays).toBeLessThanOrEqual(rule.days);
    }
  });

  // cm:guard `metrics/queries.ts` caps its own window at 90 days and reads both of these through it, so a floor under 90 lets an operator empty the tail of a chart that then reports zero rather than reporting nothing. The floor IS the cap for these two on purpose.
  it('floors the two tables the 90-day metrics window reads at 90 days', () => {
    expect(ruleFor('queue_snapshots').floorDays).toBe(90);
    expect(ruleFor('runner_events').floorDays).toBe(90);
  });

  it('states no window for the two tables that are never swept', () => {
    expect(ruleFor('mcp_audit_log').days).toBeNull();
    expect(ruleFor('mcp_audit_log').env).toBeNull();
    expect(ruleFor('agent_session_turns').days).toBeNull();
    expect(ruleFor('agent_session_turns').env).toBeNull();
  });
});

describe('retention policy: resolving the window', () => {
  it('uses the stated window when the environment says nothing', () => {
    const resolved = resolveRetention(ruleFor('job_events'), {});
    expect(resolved).toEqual({ table: 'job_events', days: 30, rejected: null });
  });

  it('takes an override at or above the floor', () => {
    const resolved = resolveRetention(ruleFor('job_events'), { RETENTION_JOB_EVENTS_DAYS: '14' });
    expect(resolved.days).toBe(14);
    expect(resolved.rejected).toBeNull();
  });

  it('takes an override exactly at the floor', () => {
    const resolved = resolveRetention(ruleFor('job_events'), { RETENTION_JOB_EVENTS_DAYS: '7' });
    expect(resolved.days).toBe(7);
    expect(resolved.rejected).toBeNull();
  });

  it('rejects an override one day below the floor, naming the variable', () => {
    const resolved = resolveRetention(ruleFor('job_events'), { RETENTION_JOB_EVENTS_DAYS: '6' });
    expect(resolved.days).toBe(7);
    expect(resolved.rejected).toContain('RETENTION_JOB_EVENTS_DAYS');
    expect(resolved.rejected).toContain('floor');
  });

  it('rejects an override that is not a number, and keeps the stated window', () => {
    const resolved = resolveRetention(ruleFor('queue_snapshots'), {
      RETENTION_QUEUE_SNAPSHOTS_DAYS: 'forever',
    });
    expect(resolved.days).toBe(90);
    expect(resolved.rejected).toContain('RETENTION_QUEUE_SNAPSHOTS_DAYS');
  });

  it('treats an empty variable as unset rather than as zero', () => {
    const resolved = resolveRetention(ruleFor('queue_snapshots'), {
      RETENTION_QUEUE_SNAPSHOTS_DAYS: '   ',
    });
    expect(resolved.days).toBe(90);
    expect(resolved.rejected).toBeNull();
  });

  // cm:guard an unswept table has no variable ON PURPOSE, so nothing in the environment may switch its sweep on: `mcp_audit_log` is unswept because the MCP deletion rule reads a count over the whole table as a lifetime count, which an operator setting a variable would not know.
  it('ignores the environment entirely for a table with no window', () => {
    const resolved = resolveRetention(ruleFor('mcp_audit_log'), {
      RETENTION_MCP_AUDIT_LOG_DAYS: '30',
    });
    expect(resolved.days).toBeNull();
  });

  it('answers the resolved window for a surface that has to render it', () => {
    expect(resolvedWindowDaysFor('runner_events', {})).toBe(90);
    expect(resolvedWindowDaysFor('runner_events', { RETENTION_RUNNER_EVENTS_DAYS: '120' })).toBe(
      120,
    );
    expect(resolvedWindowDaysFor('mcp_audit_log', {})).toBeNull();
  });

  it('refuses a table it states no rule for, rather than answering null', () => {
    expect(() => resolvedWindowDaysFor('activity_log', {})).toThrow(/no rule is stated/);
  });
});

describe('retention policy: the repair bound', () => {
  it('defaults to 200 when the environment says nothing', () => {
    expect(finalizeRepairMax({})).toBe(200);
  });

  it('takes a number from the environment, including zero to switch the pass off', () => {
    expect(finalizeRepairMax({ [FINALIZE_REPAIR_ENV]: '5' })).toBe(5);
    expect(finalizeRepairMax({ [FINALIZE_REPAIR_ENV]: '0' })).toBe(0);
  });

  it('falls back to the default on a negative or unreadable value', () => {
    expect(finalizeRepairMax({ [FINALIZE_REPAIR_ENV]: '-1' })).toBe(200);
    expect(finalizeRepairMax({ [FINALIZE_REPAIR_ENV]: 'lots' })).toBe(200);
  });
});
