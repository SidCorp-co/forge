import { describe, expect, it } from 'vitest';
import { resolveRunnerChainForJob } from './resolve-step-runner.js';

/**
 * ISS-232 Phase 3 — project-level `runnerFallback` is gone; the function
 * now resolves a single-element chain from the per-step toggle's
 * `runner` override (when present), falling back to `['claude-code']`.
 */
describe('resolveRunnerChainForJob', () => {
  it('returns hardcoded default when agentConfig is null', () => {
    expect(resolveRunnerChainForJob('triage', null)).toEqual(['claude-code']);
    expect(resolveRunnerChainForJob('triage', undefined)).toEqual(['claude-code']);
    expect(resolveRunnerChainForJob('triage', {})).toEqual(['claude-code']);
  });

  it('ignores legacy `runnerFallback` jsonb field (v2 dropped the chain)', () => {
    const cfg = { runnerFallback: ['antigravity', 'claude-code'] };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('returns default when toggle is boolean form', () => {
    const cfg = { pipelineConfig: { autoCode: true } };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('returns default when object toggle has no runner override', () => {
    const cfg = { pipelineConfig: { autoCode: { enabled: true } } };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('returns single-element chain from per-step runner override', () => {
    const cfg = {
      pipelineConfig: { autoCode: { enabled: true, runner: 'antigravity' } },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['antigravity']);
  });

  it('ignores per-step runner when not a registered type', () => {
    const cfg = {
      pipelineConfig: { autoCode: { enabled: true, runner: 'forge-cloud' } },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('returns default for unknown jobType', () => {
    const cfg = {
      pipelineConfig: { autoCode: { enabled: true, runner: 'antigravity' } },
    };
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown type input
    expect(resolveRunnerChainForJob('mystery' as any, cfg)).toEqual(['claude-code']);
  });

  it('handles malformed pipelineConfig gracefully', () => {
    const cfg = { pipelineConfig: { autoCode: 'not-an-object' } };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['claude-code']);
  });

  it('respects per-step runner per job type independently', () => {
    const cfg = {
      pipelineConfig: {
        autoCode: { enabled: true, runner: 'antigravity' },
        autoTriage: true,
      },
    };
    expect(resolveRunnerChainForJob('code', cfg)).toEqual(['antigravity']);
    expect(resolveRunnerChainForJob('triage', cfg)).toEqual(['claude-code']);
  });
});
