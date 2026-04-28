import { describe, expect, it } from 'vitest';
import { resolveRunnerChainForJob } from './resolve-step-runner.js';

describe('resolveRunnerChainForJob', () => {
  it('returns hardcoded default when agentConfig is null', () => {
    expect(resolveRunnerChainForJob('triage', null)).toEqual(['claude-code']);
    expect(resolveRunnerChainForJob('triage', undefined)).toEqual(['claude-code']);
    expect(resolveRunnerChainForJob('triage', {})).toEqual(['claude-code']);
  });

  it('returns project-level fallback when no pipelineConfig', () => {
    const cfg = { runnerFallback: ['antigravity', 'claude-code'] };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['antigravity', 'claude-code']);
  });

  it('returns project-level fallback when toggle is boolean form', () => {
    const cfg = {
      runnerFallback: ['claude-code'],
      pipelineConfig: { autoCode: true },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('returns project-level fallback when object toggle has no runner', () => {
    const cfg = {
      runnerFallback: ['claude-code'],
      pipelineConfig: { autoCode: { enabled: true } },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('prepends per-step runner and de-dupes from project chain', () => {
    const cfg = {
      runnerFallback: ['claude-code'],
      pipelineConfig: { autoCode: { enabled: true, runner: 'antigravity' } },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['antigravity', 'claude-code']);
  });

  it('prepends per-step runner without duplicating when chain already has it', () => {
    const cfg = {
      runnerFallback: ['antigravity', 'claude-code'],
      pipelineConfig: { autoCode: { enabled: true, runner: 'antigravity' } },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['antigravity', 'claude-code']);
  });

  it('ignores per-step runner when not a registered type', () => {
    const cfg = {
      runnerFallback: ['claude-code'],
      pipelineConfig: { autoCode: { enabled: true, runner: 'forge-cloud' } },
    };
    // 'forge-cloud' is not in KNOWN_RUNNER_TYPES — filtered out, fallback used.
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('returns project-level fallback for unknown jobType', () => {
    const cfg = {
      runnerFallback: ['antigravity', 'claude-code'],
      pipelineConfig: { autoCode: { enabled: true, runner: 'antigravity' } },
    };
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown type input
    expect(resolveRunnerChainForJob('mystery' as any, cfg)).toEqual(['antigravity', 'claude-code']);
  });

  it('handles malformed pipelineConfig gracefully', () => {
    const cfg = {
      runnerFallback: ['claude-code'],
      pipelineConfig: { autoCode: 'not-an-object' },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('respects per-step runner per job type independently', () => {
    const cfg = {
      runnerFallback: ['claude-code'],
      pipelineConfig: {
        autoCode: { enabled: true, runner: 'antigravity' },
        autoTriage: true,
      },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['antigravity', 'claude-code']);
    expect(resolveRunnerChainForJob('triage', cfg)).toEqual(['claude-code']);
  });
});
