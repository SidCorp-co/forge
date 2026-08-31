/**
 * ISS-145 — the registry behind the `X-MCP-Deprecation` header.
 *
 * The thing worth asserting is not that a lookup works; it is that the
 * registry and the registered tools say the same thing. A notice for a
 * factory that no longer exists can never fire, and nine of them sat here
 * doing exactly that until 2026-08-31.
 */

import { describe, expect, it } from 'vitest';
import { deprecationFor, formatDeprecationHeader } from './deprecation.js';

// cm:why each survives because a live skill calls it by name — forge-skill-audit for the first, forge-plan/forge-triage/forge-build for the second; that, not a deprecation window, is what keeps them registered in `server.ts`
const STILL_REGISTERED = ['forge_pipeline_runs.get', 'forge_pm.set_dependency'];

/** Deleted with their factories — a notice for any of these is unreachable. */
const RETIRED = [
  'forge_pipeline_runs.list',
  'forge_pipeline_runs.pause',
  'forge_pipeline_runs.resume',
  'forge_pipeline_runs.cancel',
  'forge_pm.snapshot',
  'forge_pm.graph',
  'forge_pm.runner_load',
  'forge_pm.dispatch',
  'forge_pm.write_decision',
];

describe('deprecationFor', () => {
  it('answers for every legacy name that is still registered', () => {
    for (const name of STILL_REGISTERED) {
      const notice = deprecationFor(name);
      expect(notice, `notice for ${name}`).not.toBeNull();
      expect(notice?.tool).toBe(name);
      expect(notice?.replacement).toMatch(/^forge_project_(pipeline_runs|pm) \(action=\w+\)$/);
    }
  });

  // cm:guard the registry may hold NOTHING but the names `server.ts` still registers. A notice outliving its factory cannot fire, so it is not a warning — it is a claim, in the one file a reader consults to learn which names are on the way out, that Forge still answers to a tool it deleted. Re-add any RETIRED entry to `NOTICES` and only this goes red.
  it('has forgotten every name whose factory was deleted', () => {
    const stillListed = RETIRED.filter((name) => deprecationFor(name) !== null);
    expect(stillListed).toEqual([]);
  });

  it('returns null for a tool that was never deprecated', () => {
    expect(deprecationFor('forge_issues')).toBeNull();
    expect(deprecationFor('forge_project_pm')).toBeNull();
    expect(deprecationFor('forge_project_pipeline_runs')).toBeNull();
  });
});

describe('formatDeprecationHeader', () => {
  it('joins notices in stable alphabetical order', () => {
    const header = formatDeprecationHeader(['forge_pm.set_dependency', 'forge_pipeline_runs.get']);
    expect(header).toBe(
      'forge_pipeline_runs.get=forge_project_pipeline_runs (action=get), forge_pm.set_dependency=forge_project_pm (action=set_dependency)',
    );
  });

  it('emits empty string when no notices match', () => {
    expect(formatDeprecationHeader(['forge_issues'])).toBe('');
  });

  it('skips a name the registry has forgotten rather than inventing a header', () => {
    expect(formatDeprecationHeader(['forge_pm.snapshot'])).toBe('');
  });
});
