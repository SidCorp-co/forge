import { describe, expect, it } from 'vitest';
import { RETIRED_JOB_TYPES } from '../../db/job-vocabulary.js';
import { ISSUE_ACTIONS } from '../../mcp/tools/forge-issues-actions.js';
import { FORGE_FACTS, OPERATING_AFFORDANCES_TEXT } from './registry.js';

describe('FORGE_FACTS', () => {
  it('no fact applies to a retired staged-pipeline stage (ISS-1229)', () => {
    const retired: ReadonlySet<string> = new Set(RETIRED_JOB_TYPES);
    const offenders = FORGE_FACTS.flatMap((f) =>
      (f.appliesTo ?? []).filter((s) => retired.has(s)).map((s) => `${f.id}:${s}`),
    );
    expect(offenders).toEqual([]);
  });

  // ISS-1229 r16, judge-41: a failed job never writes its issue's status (criterion 6), so no fact may
  // tell an agent the system reverts the issue after a crash.
  it('says a crashed job leaves its issue where it is', () => {
    const rules = FORGE_FACTS.find((f) => f.id === 'pipeline-rules')?.render() ?? '';
    expect(rules).toContain("leaves the issue's status as it is and re-dispatches the job");
    expect(rules).not.toMatch(/reverts the issue/i);
  });

  it('tells no agent to send a complete entry, the config write ISS-1170 retired', () => {
    const texts = [OPERATING_AFFORDANCES_TEXT, ...FORGE_FACTS.map((f) => f.render())];
    expect(texts.filter((t) => /complete entry/i.test(t))).toEqual([]);
    expect(OPERATING_AFFORDANCES_TEXT).toContain('pipelineConfigBase');
    expect(OPERATING_AFFORDANCES_TEXT).toContain('CONFIG_STALE');
  });

  it('names only forge_issues actions the tool serves', () => {
    const served: ReadonlySet<string> = new Set(ISSUE_ACTIONS);
    const named = [...OPERATING_AFFORDANCES_TEXT.matchAll(/forge_issues action=(\w+)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((a) => !served.has(a))).toEqual([]);
  });
});
