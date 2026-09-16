// Unit tests for the pure stage-block renderer (`renderStageFactsText`).
// The DB-backed loader is exercised via prompt/routes.test.ts; here we feed
// fabricated `ProjectFactInputs` so the inline-vs-pointer policy is pinned
// without a database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../config/env.js', () => ({ env: { KNOWLEDGE_INJECTION_ENABLED: false } }));
vi.mock('../../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
}));

const warnSpy = vi.fn();
vi.mock('../../logger.js', () => ({
  logger: { warn: (...a: unknown[]) => warnSpy(...a) },
}));

const { renderStageFactsText, renderIntegrations, makeProjectResolver } = await import(
  './resolve.js'
);
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
        sentryTargets: [
          {
            label: 'Backend',
            organizationSlug: 'acme',
            projectSlug: 'be',
            notes: '5xx errors',
          },
          { label: 'Mobile', organizationSlug: 'acme', projectSlug: 'mob' },
        ],
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
        sentryTargets: [],
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
        sentryTargets: [{ label: 'Backend', organizationSlug: 'acme', projectSlug: 'be' }],
        instructions: 'Only triage P1s.',
      },
    ]);
    expect(text.indexOf('Backend: org=acme')).toBeLessThan(
      text.indexOf('Project-specific instructions'),
    );
  });
});

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

/**
 * `{{project:<key>}}` — what a skill body gets when it asks for a branch.
 *
 * ISS-1046 retired `{{project:production-branch}}` and introduced `{{project:live-branch}}`,
 * which resolves only where the project declares it promotes. Both halves matter and neither
 * was asserted anywhere: the resolver was built privately inside the DB-backed loader, so the
 * only way to reach it was through a database.
 */
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
      projectFacts: {},
      ...over,
    });
  }

  it('resolves `live-branch` under `promote`', () => {
    expect(resolver()('live-branch')).toBe('production');
  });

  it.each(['publish', 'none'] as const)('resolves `live-branch` to nothing under `%s`', (m) => {
    expect(resolver({ releaseModel: m })('live-branch')).toBeUndefined();
  });

  it('resolves `live-branch` to nothing under `promote` when there is no branch', () => {
    expect(resolver({ liveBranch: null })('live-branch')).toBeUndefined();
  });

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

  it('leaves an author-defined fact alone', () => {
    expect(resolver({ projectFacts: { 'deploy-notes': 'ssh first' } })('deploy-notes')).toBe(
      'ssh first',
    );
    expect(resolver()('base-branch')).toBe('main');
  });
});
