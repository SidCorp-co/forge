/**
 * The autonomous driver's prompt names one transport, and it is the CLI.
 *
 * The driver skill (`issue-flow`, delivered as a plugin) and this prompt are read in the same context
 * window. They disagreed until 2026-09-02 — the skill said `forge-runner api`
 * and core's prompt said `forge_step_start` / `forge_step_handoff.write` /
 * `forge_issues.update` — and the agent believed the prompt: 4,806 and 4,268
 * MCP calls respectively, every one on an autonomous project.
 *
 * The rule under test is ONE NAME, not an unreachable tool. The driver has a
 * working Forge MCP client and always did (376 `forge_phase` device calls in
 * the 3 days to 2026-09-02, all on autonomous projects, from a skill that is
 * the only caller of it). The CLI wins because the job PAT is minted per job,
 * scoped to one project and revoked at terminal, where the device token behind
 * the MCP path is long-lived and fleet-wide — and because the skill, which
 * ships compiled into the runner, already says so.
 */

import { describe, expect, it } from 'vitest';
import {
  mandatoryPreambleBlocks,
  PIPELINE_RULES,
  TOOL_REFERENCE,
} from './facts/mandatory-blocks.js';
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
      'core named a third transport for a lane whose skill and preamble both speak the CLI',
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

describe('the mandatory preamble blocks fork with the lane', () => {
  // cm:guard `forge_uploads` is the ONE deliberate name, and the exception is real rather than a lapse: reading an attached image needs a multimodal fetch that returns an image content block, which no shell command can produce. Everything else must resolve to a `forge-runner api` path — and assert the staged half too, because a zero-count alone passes on a block that renders empty.
  it('hands a driver a preamble naming only the tool with no shell form', () => {
    const { pipelineRules, toolReference } = mandatoryPreambleBlocks('drive');
    const text = `${pipelineRules}\n${toolReference}`;
    const named = [...text.matchAll(/forge_[a-z_.]+/g)]
      .map((m) => m[0])
      .filter((t) => t !== 'forge_');
    expect([...new Set(named)]).toEqual(['forge_uploads']);
    expect(text.length).toBeGreaterThan(1000);
  });

  it('drops the rules a driver cannot act on rather than translating them', () => {
    const { pipelineRules } = mandatoryPreambleBlocks('drive');
    for (const dead of [
      'ladder',
      '`waiting`',
      '`reopen`',
      '`on_hold`',
      'open → confirmed',
      'Five rounds',
    ]) {
      expect(pipelineRules, `${dead} has no meaning in the autonomous lane`).not.toContain(dead);
    }
  });

  it('keeps the rules a driver does act on', () => {
    const { pipelineRules } = mandatoryPreambleBlocks('drive');
    for (const kept of [
      'never background-and-exit',
      'reset --hard',
      'stale clone',
      'merge-base --is-ancestor',
      'Never speak for a human',
    ]) {
      expect(pipelineRules).toContain(kept);
    }
  });

  it('leaves every staged step on the byte-identical shared prefix', () => {
    for (const step of ['code', 'review', 'test', 'triage', null] as const) {
      const { pipelineRules, toolReference } = mandatoryPreambleBlocks(step);
      expect(pipelineRules).toBe(PIPELINE_RULES);
      expect(toolReference).toBe(TOOL_REFERENCE);
    }
  });
});

describe('the release-notes fact clears the gate it describes', () => {
  const render = (stage: 'drive' | 'release') =>
    getFact('release-notes-format')?.render?.({ stage } as never) ?? '';

  // cm:guard RELEASE_RECORD_REQUIRED refuses an agent close while `releaseNotes` is null, so this fact is the driver's own exit instruction — naming a tool it cannot call leaves it stuck at a gate with no reachable remedy
  it('names a call the driver can make', () => {
    expect([...render('drive').matchAll(/forge_[a-z_.]+/g)].map((m) => m[0])).toEqual([]);
    expect(render('drive')).toContain('forge-runner api issues/<id> -X PATCH');
  });

  it('still names the MCP tool for the staged release step', () => {
    expect(render('release')).toContain('forge_issues.update');
  });

  // cm:guard the driver is the last stage there is, so a promise that forge-release writes its CHANGELOG line is a stage that never runs — and `RELEASE_RECORD_REQUIRED` gates the close on `releaseNotes` alone, so the missing entry closes green
  it('does not promise the driver a changelog append no later stage performs', () => {
    expect(render('drive')).not.toContain('forge-release appends');
    expect(render('drive')).toContain('you write the `CHANGELOG.md` line yourself');
  });

  it('still tells the staged release step that forge-release appends it', () => {
    expect(render('release')).toContain('forge-release appends this to the changelog at close.');
  });
});

describe('the worktree lifecycle reaches the one job that runs unattended', () => {
  // cm:guard both halves or neither: `worktree-protocol` says create-and-reuse and `worktree-cleanup` is the only place removal is asked for, so adding drive to the first alone gives the driver a worktree nothing ever removes — the shape that put 17G of `.claude/worktrees` on one box
  it('gives the driver both halves', () => {
    expect(getFact('worktree-protocol')?.appliesTo).toContain('drive');
    expect(getFact('worktree-cleanup')?.appliesTo).toContain('drive');
  });

  it('does not send the driver to a release step this mode does not have', () => {
    expect(getFact('worktree-protocol')?.render?.()).not.toContain('release-stage step');
  });
});
