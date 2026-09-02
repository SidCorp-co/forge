/**
 * The autonomous driver's prompt names one transport, and it is the CLI.
 *
 * The bundled `forge-drive` skill and this prompt are read in the same context
 * window. They disagreed until 2026-09-02 — the skill said `forge-runner api`
 * and core's prompt said `forge_step_start` / `forge_step_handoff.write` /
 * `forge_issues.update` — and the agent believed the prompt: 4,806 and 4,268
 * MCP calls respectively, every one on an autonomous project.
 */

import { describe, expect, it } from 'vitest';
import { getFact } from './facts/registry.js';
import { buildJobPromptString, type IssueSnapshot } from './user.js';

const SNAPSHOT: IssueSnapshot = {
  title: 'a title',
  description: 'a body',
  plan: null,
  acceptanceCriteria: null,
  sessionContext: null,
};

const SCOPE = { projectId: 'p1', issueId: 'i1', runId: 'r1', attempt: 1 };

function prompt(jobType: 'drive' | 'code') {
  return buildJobPromptString({
    jobType,
    issueId: 'i1',
    issueSnapshot: SNAPSHOT,
    handoffScope: SCOPE,
    priorHandoffs: [],
  });
}

describe('the drive prompt speaks the CLI', () => {
  it('names no MCP tool at all', () => {
    const found = [...prompt('drive').matchAll(/forge_[a-z_.]+/g)].map((m) => m[0]);
    expect(
      found,
      'core told the driver to call a tool its shell cannot reach, against a bundled skill that names none',
    ).toEqual([]);
  });

  it('points at the issue route rather than a fetch tool', () => {
    expect(prompt('drive')).toContain('forge-runner api issues/<id>');
  });

  it('writes the handoff and the status over the CLI', () => {
    const p = prompt('drive');
    expect(p).toContain('forge-runner api issue-step-contexts -X POST');
    expect(p).toContain('forge-runner api issues/i1 -X PATCH');
  });

  it('does not send the driver to a ladder this mode has no steps for', () => {
    expect(prompt('drive')).not.toContain('Pipeline Rules ladder');
  });

  it('offers neither park that autonomous-park.ts silently rewrites', () => {
    const p = prompt('drive');
    for (const parked of ['`waiting`', '`reopen`']) {
      expect(
        p,
        `${parked} is rewritten at write time; instructing it fires the net every session`,
      ).not.toContain(parked);
    }
  });
});

describe('the staged lane is untouched', () => {
  it('keeps the fetch tool and the ladder for a staged step', () => {
    const p = prompt('code');
    expect(p).toContain('forge_step_start');
    expect(p).toContain('forge_step_handoff.write');
    expect(p).toContain('Pipeline Rules ladder');
  });
});

describe('the injected step-handoff fact follows the same lane split', () => {
  const render = (stage: 'drive' | 'code') =>
    getFact('handoff')?.render?.({ stage } as never) ?? '';

  it('applies to drive at all — which is why it has to fork', () => {
    expect(getFact('handoff')?.appliesTo).toContain('drive');
  });

  it('names no MCP tool for drive', () => {
    expect([...render('drive').matchAll(/forge_[a-z_.]+/g)].map((m) => m[0])).toEqual([]);
  });

  it('still names the MCP tool for a staged step', () => {
    expect(render('code')).toContain('forge_step_handoff.write');
  });
});
