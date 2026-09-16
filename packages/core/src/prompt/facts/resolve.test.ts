// Unit tests for the pure stage-block renderer (`renderStageFactsText`).
// The DB-backed loader is exercised via prompt/routes.test.ts; here we feed
// fabricated `ProjectFactInputs` so the inline-vs-pointer policy is pinned
// without a database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
  selectAllSlugsFromKnowledge: vi.fn(),
}));

const warnSpy = vi.fn();
vi.mock('../../logger.js', () => ({
  logger: { warn: (...a: unknown[]) => warnSpy(...a) },
}));

const { renderStageFactsText, renderIntegrations, makeProjectResolver } = await import(
  './resolve.js'
);

// `renderIntegrations` reads each provider's hint, guide slug and extra line off its DECLARATION
// (ISS-1071), so the registry has to hold one. Reading it empty throws rather than rendering the
// generic line for every provider, which is the answer that would have made these assertions pass
// while saying nothing true.
const { registerAllIntegrations } = await import('../../integrations/register-all.js');
registerAllIntegrations();
type Inputs = Parameters<typeof renderStageFactsText>[0];

const GUIDE_TEXT = 'pnpm build && pnpm test -- THE FULL GUIDE BODY';

function makeInputs(overrides?: Partial<Inputs>): Inputs {
  const values: Record<string, string> = {
    integrations:
      '## Project integrations\nConnected integrations and how to use them:\n- **coolify** [production] — Deploy via `forge_coolify_deploy`.',
    'test-urls': '- beta: https://forge-beta.example.com',
    'build-commands': GUIDE_TEXT,
  };
  return {
    ladder: ['open', 'confirmed', 'approved', 'developed', 'testing', 'awaiting_release', 'closed'],
    branches: { baseBranch: null, liveBranch: null, releaseModel: 'none' as const },
    noProgressRounds: 5,
    project: (key: string) => values[key],
    projectFactKeys: ['build-commands'],
    alwaysInjectFacts: [],
    factsUnavailable: false,
    missingObligations: [],
    modules: [],
    ...overrides,
  };
}

describe('renderStageFactsText', () => {
  it('demotes fact headers to ### so they nest under ## Forge context', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'drive');
    expect(text.startsWith('## Forge context')).toBe(true);
    expect(text).toContain('### Step handoff (best-effort)');
    expect(text).toContain('### Worktree isolation');
    expect(text).toContain('### Project integrations');
    expect(text.match(/^## (?!Forge context)/gm)).toBeNull();
  });

  it('lists projectFacts as a fetch-on-demand index, never inlining guide bodies', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'drive');
    expect(text).toContain('### Project guides (fetch on demand)');
    expect(text).toContain('- build-commands');
    expect(text).toContain('`forge_knowledge`');
    expect(text).not.toContain(GUIDE_TEXT);
  });

  it('omits the guides index when the project has no authored facts', () => {
    const text = renderStageFactsText(makeInputs({ projectFactKeys: [] }), 'p-1', 'drive');
    expect(text).not.toContain('Project guides');
  });

  it('does not inline test URLs (covered by the forge_projects.get pointer)', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'drive');
    expect(text).not.toContain('forge-beta.example.com');
  });

  // cm:guard `appliesTo` is the whole of the scoping, so the claim needs a stage that GETS a
  // fact and one that does not. Since ISS-1047 the only claimable stage with contextual facts is
  // `drive`; `release_batch` is the live counter-case and gets none of them.
  it('scopes facts by stage', () => {
    const drive = renderStageFactsText(makeInputs(), 'p-1', 'drive');
    expect(drive).toContain('Step handoff');
    expect(drive).toContain('Worktree isolation');
    expect(drive).toContain('Release-notes shape');

    const releaseBatch = renderStageFactsText(makeInputs(), 'p-1', 'release_batch');
    expect(releaseBatch).not.toContain('Step handoff');
    expect(releaseBatch).not.toContain('Worktree isolation');
    expect(releaseBatch).not.toContain('Release-notes shape');
    expect(releaseBatch).toContain('### Project integrations');
  });

  it('keeps issue-bound facts out of pm jobs', () => {
    const pm = renderStageFactsText(makeInputs(), 'p-1', 'pm');
    expect(pm).not.toContain('Release-notes shape');
    expect(pm).not.toContain('Worktree isolation');
    expect(pm).not.toContain('forge_step_handoff');
    expect(pm).toContain('### Project integrations');
    expect(pm).toContain('Project guides (fetch on demand)');
  });
});

// cm:guard assert the RENDERED release block, not the registry's `appliesTo` — the two are separated by resolve.ts's tier filter, and the whole defect this closes was an instruction that existed in the registry and reached no prompt. Checking the metadata would have passed the entire time the leak was open.
describe('renderStageFactsText — worktree cleanup reaches the release prompt', () => {
  it('injects the removal step at release', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'release');
    expect(text).toContain("### Remove this issue's worktree");
    expect(text).toContain('git worktree remove');
    expect(text).toContain('git worktree prune');
  });

  it('does NOT inject it at the stages that re-enter the worktree', () => {
    for (const stage of ['code', 'fix', 'review', 'test'] as const) {
      const text = renderStageFactsText(makeInputs(), 'p-1', stage);
      expect(text, `must not reach ${stage}`).not.toContain("### Remove this issue's worktree");
    }
  });

  it('still gives code/fix the create-and-reuse half', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'code');
    expect(text).toContain('### Worktree isolation');
    expect(text).toContain('Do NOT delete it when you finish');
  });
});

describe('renderStageFactsText — always-inject tier (ISS-521)', () => {
  beforeEach(() => warnSpy.mockClear());

  const RULE = 'NEVER import @forge/contracts internals across the package boundary.';

  it('AC#1 / AC#5: renders an always-inject fact VERBATIM and excludes it from the guides index', () => {
    const text = renderStageFactsText(
      makeInputs({
        projectFactKeys: ['contracts-boundary', 'build-commands'],
        alwaysInjectFacts: [{ key: 'contracts-boundary', text: RULE }],
      }),
      'p-1',
      'code',
    );
    expect(text).toContain('### Project rules (always applied)');
    expect(text).toContain('#### contracts-boundary');
    expect(text).toContain(RULE);
    const indexSection = text.slice(text.indexOf('### Project guides (fetch on demand)'));
    expect(indexSection).not.toContain('- contracts-boundary');
    expect(indexSection).toContain('- build-commands');
  });

  // cm:guard ISS-936 decided this heading KEEPS "Follow them exactly." and does NOT carry the sentence about nothing checking the rule — that sentence is owed to the owner who sets the flag, and putting it in the rule's own prompt tells the agent that ignoring the rule costs nothing.
  it('ISS-936: the heading instructs the agent and makes the agent no excuse', () => {
    const text = renderStageFactsText(
      makeInputs({ alwaysInjectFacts: [{ key: 'contracts-boundary', text: RULE }] }),
      'p-1',
      'code',
    );
    expect(text).toContain('Follow them exactly.');
    expect(text).not.toContain('never that it was DONE');
    expect(text).not.toContain('No gate refuses');
  });

  it('AC#2: a non-flagged fact still renders only as a pointer, never inlined', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'code');
    expect(text).not.toContain('### Project rules (always applied)');
    expect(text).toContain('### Project guides (fetch on demand)');
    expect(text).toContain('- build-commands');
  });

  it('AC#2: caps the summed always-inject content and warns on overflow (still injects)', () => {
    const big = 'x'.repeat(7000); // exceeds PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS (6000)
    const text = renderStageFactsText(
      makeInputs({
        projectFactKeys: ['huge'],
        alwaysInjectFacts: [{ key: 'huge', text: big }],
      }),
      'p-1',
      'code',
    );
    // Never silently dropped — the full rule is present…
    expect(text).toContain(big);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta] = warnSpy.mock.calls[0] as [{ totalChars: number; maxChars: number }];
    expect(meta.totalChars).toBe(7000);
    expect(meta.maxChars).toBe(6000);
  });

  it('does not warn when always-inject content is within budget', () => {
    renderStageFactsText(
      makeInputs({ alwaysInjectFacts: [{ key: 'small', text: RULE }] }),
      'p-1',
      'code',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('renderIntegrations — Sentry targets (ISS-526)', () => {
  it('lists the configured Sentry targets under the provider bullet', () => {
    const text = renderIntegrations([
      {
        provider: 'sentry',
        role: 'service',
        stages: [],
        lastHealthStatus: 'ok',
        // ISS-1071 — the row carries the provider's OWN rendered line now. `loadActiveIntegrationRows`
        // builds it from the sentry declaration's `usage.renderExtra`; the renderer only places it.
        extraLine: '  - Backend: org=acme project=be — 5xx errors\n  - Mobile: org=acme project=mob',
      },
    ]);
    expect(text).toContain('- **sentry** [service] (health: ok)');
    expect(text).toContain('  - Backend: org=acme project=be — 5xx errors');
    expect(text).toContain('  - Mobile: org=acme project=mob');
  });

  it('renders just the bullet when a Sentry binding has no targets', () => {
    const text = renderIntegrations([
      {
        provider: 'sentry',
        role: 'service',
        stages: [],
        lastHealthStatus: null,
        extraLine: null,
      },
    ]);
    expect(text).toContain('- **sentry** [service]');
    expect(text).not.toContain('  - ');
  });
});

describe('renderIntegrations — capability-guide pointer (ISS-746)', () => {
  it('appends a forge_guide pointer on the same line for a provider with a seeded guide (coolify)', () => {
    const text = renderIntegrations([
      { provider: 'coolify', role: 'deploy', stages: ['preview'], lastHealthStatus: 'ok' },
    ]);
    expect(text).toContain('Full guide: `forge_guide get deploy-safety`.');
    // Same bullet line, not a new line.
    expect(text).toContain(
      '- **coolify** [preview] (health: ok) — Deploy / redeploy and poll deployment status via the `forge_coolify_deploy` tool. Full guide: `forge_guide get deploy-safety`.',
    );
  });

  it('renders unchanged for a provider with no seeded guide (postman)', () => {
    const text = renderIntegrations([
      { provider: 'postman', role: 'service', stages: [], lastHealthStatus: null },
    ]);
    expect(text).not.toContain('Full guide:');
  });

  it('points at the org runtime guide for a provider that has no seeded slug (epodsystem)', () => {
    const text = renderIntegrations([
      {
        provider: 'epodsystem',
        role: 'deploy',
        stages: ['preview', 'live'],
        lastHealthStatus: 'ok',
        hasOrgGuide: true,
      },
    ]);
    expect(text).toContain('Full guide: `forge_guide get integration-epodsystem`.');
  });

  // cm:guard the org's runtime guide must WIN over the seeded slug — an org authors one to correct the shipped default, so pointing at the default would send the agent to the text they replaced
  it('the org guide overrides a seeded slug (coolify)', () => {
    const text = renderIntegrations([
      {
        provider: 'coolify',
        role: 'deploy',
        stages: ['preview'],
        lastHealthStatus: 'ok',
        hasOrgGuide: true,
      },
    ]);
    expect(text).toContain('Full guide: `forge_guide get integration-coolify`.');
    expect(text).not.toContain('deploy-safety');
  });
});

describe('renderIntegrations — per-binding instructions (A11)', () => {
  it('renders operator instructions as an indented sub-block under the bullet', () => {
    const text = renderIntegrations([
      {
        provider: 'epodsystem',
        role: 'deploy',
        stages: ['preview', 'live'],
        lastHealthStatus: 'ok',
        instructions: 'Never publish before 09:00 ICT.\nAsk the owner for the size chart.',
      },
    ]);
    expect(text).toContain('Project-specific instructions for **epodsystem**');
    expect(text).toContain('    Never publish before 09:00 ICT.');
    expect(text).toContain('    Ask the owner for the size chart.');
  });

  // cm:guard every line must stay indented — an unindented operator line escapes its bullet and reads to the agent as a new top-level instruction
  it('indents every line of a multi-line instruction', () => {
    const text = renderIntegrations([
      {
        provider: 'epodsystem',
        role: 'deploy',
        stages: ['preview', 'live'],
        lastHealthStatus: null,
        instructions: 'line one\nline two\nline three',
      },
    ]);
    for (const line of ['line one', 'line two', 'line three']) {
      expect(text).toContain(`    ${line}`);
    }
    expect(text).not.toMatch(/^line two$/m);
  });

  it('says instructions win over the general guide where they conflict', () => {
    const text = renderIntegrations([
      {
        provider: 'epodsystem',
        role: 'deploy',
        stages: ['preview', 'live'],
        lastHealthStatus: null,
        instructions: 'x',
      },
    ]);
    expect(text).toContain('follow these over the general guide where they conflict');
  });

  it('renders nothing extra for blank or whitespace-only instructions', () => {
    for (const instructions of [null, '', '   \n  ']) {
      const text = renderIntegrations([
        {
          provider: 'epodsystem',
          role: 'deploy',
          stages: ['preview', 'live'],
          lastHealthStatus: null,
          instructions,
        },
      ]);
      expect(text).not.toContain('Project-specific instructions');
    }
  });

  it('keeps both Sentry targets and instructions, targets first', () => {
    const text = renderIntegrations([
      {
        provider: 'sentry',
        role: 'service',
        stages: [],
        lastHealthStatus: 'ok',
        extraLine: '  - Backend: org=acme project=be',
        instructions: 'Only triage P1s.',
      },
    ]);
    expect(text.indexOf('Backend: org=acme')).toBeLessThan(
      text.indexOf('Project-specific instructions'),
    );
  });
});

// cm:guard assert the RENDERED block for both projects, never the registry's `relevant` predicate — the predicate could be correct while the tier filter never consults it, which is exactly how the ISS-552 leak stayed open
describe('renderStageFactsText — module attribution is gated on the taxonomy (ISS-595)', () => {
  const MODULES = [
    { name: 'billing', parentName: null },
    { name: 'invoices', parentName: 'billing' },
  ];

  it('names every module of a project that has a taxonomy', () => {
    const text = renderStageFactsText(makeInputs({ modules: MODULES }), 'p-1', 'drive');
    expect(text).toContain("### The issue's primary module");
    expect(text).toContain('- billing');
    expect(text).toContain('- invoices (under billing)');
  });

  it('names the isPrimary attach payload as the carrier, and refuses the comment line', () => {
    const text = renderStageFactsText(makeInputs({ modules: MODULES }), 'p-1', 'drive');
    expect(text).toContain('isPrimary: true');
    expect(text).toContain('forge_issues.update');
    expect(text).toContain('**Set it on the issue itself, never in a comment.**');
    expect(text).toContain('is NOT the attribution and nothing reads it');
  });

  it('renders NOTHING for a project with no module labels', () => {
    const text = renderStageFactsText(makeInputs({ modules: [] }), 'p-1', 'drive');
    expect(text).not.toContain('primary module');
    expect(text).not.toContain('isPrimary');
  });

  it('adds no section to a project with no module labels — the headings are pinned', () => {
    // cm:why the pinned list is the exact heading set a taxonomy-less project got before this change, so a section that leaks past the predicate lands here as an extra entry whatever its wording — asserting `not.toContain` of one phrase would pass on a reworded leak
    const headings = (text: string) => text.split('\n').filter((l) => l.startsWith('### '));
    expect(headings(renderStageFactsText(makeInputs({ modules: [] }), 'p-1', 'drive'))).toEqual([
      '### Release-notes shape',
      '### Step handoff (best-effort)',
      '### Worktree isolation',
      "### Remove this issue's worktree",
      '### Project integrations',
      '### Project guides (fetch on demand)',
    ]);
    expect(
      headings(renderStageFactsText(makeInputs({ modules: MODULES }), 'p-1', 'drive')),
    ).toContain("### The issue's primary module");
  });

  it('stays out of pm jobs, which have no issue to attribute', () => {
    const text = renderStageFactsText(makeInputs({ modules: MODULES }), 'p-1', 'pm');
    expect(text).not.toContain("### The issue's primary module");
  });
});

describe('makeProjectResolver — the branch a skill body is handed', () => {
  function resolver(over: Partial<Parameters<typeof makeProjectResolver>[0]> = {}) {
    return makeProjectResolver({
      baseBranch: 'main',
      liveBranch: 'production',
      releaseModel: 'promote',
      repoPath: '/repo',
      testingUrls: [],
      testNotes: null,
      integrations: [],
      ...over,
    });
  }

  it('resolves `live-branch` under `promote`', () => {
    expect(resolver()('live-branch')).toBe('production');
  });

  // cm:guard the row KEEPS its branch under the other two models — the migration does not discard
  // a real declaration — so the resolver is what stops a skill body stating a release target for a
  // project that declares it has no branch-based release.
  it.each(['publish', 'none'] as const)('resolves `live-branch` to nothing under `%s`', (m) => {
    expect(resolver({ releaseModel: m })('live-branch')).toBeUndefined();
  });

  it('resolves `live-branch` to nothing under `promote` when there is no branch', () => {
    expect(resolver({ liveBranch: null })('live-branch')).toBeUndefined();
  });

  // cm:guard a REFUSAL rather than `undefined`. An unresolved `{{project:…}}` renders as empty,
  // so answering `undefined` here would silently delete a sentence from the prompt of every
  // project whose skill body still uses the retired key — and no gate in THIS repo can see a
  // skill body in another one.
  it('refuses the retired `production-branch` by name instead of resolving to nothing', () => {
    const out = resolver()('production-branch');
    expect(out).toBeDefined();
    expect(out).toContain('production-branch');
    expect(out).toContain('was retired');
    expect(out).toContain('{{project:live-branch}}');
    // It names the condition the replacement resolves under, so the reader can tell whether
    // their project will get a value at all.
    expect(out).toContain('promote');
  });

  it('refuses it under every model, including a project that does promote', () => {
    for (const m of ['promote', 'publish', 'none'] as const) {
      expect(resolver({ releaseModel: m })('production-branch'), m).toContain('was retired');
    }
  });

  // cm:guard until ISS-1048 the resolver carried an `agentConfig.projectFacts` map and answered any
  // key in it, so `{{project:deploy-notes}}` spliced project prose inline. The prose is in
  // `knowledge_entries` now and the resolver holds no map at all — every unreserved key gets the
  // refusal, which is what tells the skill author their reference has stopped resolving.
  it('refuses an unreserved key by name rather than resolving it from a map', () => {
    const out = resolver()('deploy-notes');
    expect(out).toContain('{{project:deploy-notes}}');
    expect(out).toContain('forge_knowledge');
    expect(out).toContain('ISS-1048');
  });

  it('still resolves the reserved keys, which are derived from project columns', () => {
    expect(resolver()('base-branch')).toBe('main');
    expect(resolver()('repo-path')).toBe('/repo');
  });
});
