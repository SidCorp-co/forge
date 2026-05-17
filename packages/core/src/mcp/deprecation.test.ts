/**
 * ISS-145 — Unit coverage for the deprecation registry that drives the
 * `X-MCP-Deprecation` response header emitted by `handler.ts`.
 */

import { describe, expect, it } from 'vitest';
import { deprecationFor, formatDeprecationHeader } from './deprecation.js';

describe('deprecationFor', () => {
  it('returns a notice for each legacy tool name', () => {
    for (const name of [
      'forge_pipeline_runs.list',
      'forge_pipeline_runs.get',
      'forge_pipeline_runs.pause',
      'forge_pipeline_runs.resume',
      'forge_pipeline_runs.cancel',
      'forge_pm.snapshot',
      'forge_pm.graph',
      'forge_pm.runner_load',
      'forge_pm.dispatch',
      'forge_pm.set_dependency',
      'forge_pm.write_decision',
    ]) {
      const notice = deprecationFor(name);
      expect(notice, `notice for ${name}`).not.toBeNull();
      expect(notice?.tool).toBe(name);
    }
  });

  it('returns null for non-deprecated tools', () => {
    expect(deprecationFor('forge_issues')).toBeNull();
    expect(deprecationFor('forge_project_pm')).toBeNull();
    expect(deprecationFor('forge_project_pipeline_runs')).toBeNull();
    // Out-of-scope pm tools stay standalone and must not be flagged.
    expect(deprecationFor('forge_pm.flag_blocker')).toBeNull();
    expect(deprecationFor('forge_pm.escalate')).toBeNull();
  });
});

describe('formatDeprecationHeader', () => {
  it('joins notices in stable alphabetical order', () => {
    const header = formatDeprecationHeader([
      'forge_pm.snapshot',
      'forge_pipeline_runs.list',
    ]);
    expect(header).toBe(
      'forge_pipeline_runs.list=forge_project_pipeline_runs (action=list), forge_pm.snapshot=forge_project_pm (action=snapshot)',
    );
  });

  it('emits empty string when no notices match', () => {
    expect(formatDeprecationHeader(['forge_issues'])).toBe('');
  });
});
