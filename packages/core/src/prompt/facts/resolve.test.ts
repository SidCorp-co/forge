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

const { renderStageFactsText, renderIntegrations } = await import('./resolve.js');
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
    ladder: ['open', 'confirmed', 'approved', 'developed', 'testing', 'released', 'closed'],
    branches: { baseBranch: null, productionBranch: null },
    noProgressRounds: 5,
    project: (key: string) => values[key],
    projectFactKeys: ['build-commands'],
    alwaysInjectFacts: [],
    ...overrides,
  };
}

describe('renderStageFactsText', () => {
  it('demotes fact headers to ### so they nest under ## Forge context', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'triage');
    expect(text.startsWith('## Forge context')).toBe(true);
    expect(text).toContain('### Status ladder');
    expect(text).toContain('### Issue relation kinds');
    expect(text).toContain('### Project integrations');
    // No sibling-level headers besides the wrapper itself.
    expect(text.match(/^## (?!Forge context)/gm)).toBeNull();
  });

  it('renders the project-resolved ladder', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'code');
    expect(text).toContain('open → confirmed → approved → developed → testing → released → closed');
  });

  it('lists projectFacts as a fetch-on-demand index, never inlining guide bodies', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'code');
    expect(text).toContain('### Project guides (fetch on demand)');
    expect(text).toContain('- build-commands');
    expect(text).toContain('`forge_knowledge`');
    expect(text).not.toContain(GUIDE_TEXT);
  });

  it('omits the guides index when the project has no authored facts', () => {
    const text = renderStageFactsText(makeInputs({ projectFactKeys: [] }), 'p-1', 'code');
    expect(text).not.toContain('Project guides');
  });

  it('does not inline test URLs (covered by the forge_projects.get pointer)', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'clarify');
    expect(text).not.toContain('forge-beta.example.com');
  });

  it('scopes facts by stage', () => {
    const triage = renderStageFactsText(makeInputs(), 'p-1', 'triage');
    expect(triage).toContain('Complexity scale');
    expect(triage).toContain('Step handoff');

    const code = renderStageFactsText(makeInputs(), 'p-1', 'code');
    expect(code).toContain('Worktree isolation');
    expect(code).not.toContain('Complexity scale');

    // release has no handoff schema — the instruction must not appear.
    const release = renderStageFactsText(makeInputs(), 'p-1', 'release');
    expect(release).not.toContain('forge_step_handoff');
    expect(release).toContain('Release-notes shape');
  });

  it('feedback-red-flag fact appears in code/fix, absent for plan/review (ISS-552)', () => {
    const RED_FLAG_TRIGGER = 'report the friction';

    const code = renderStageFactsText(makeInputs(), 'p-1', 'code');
    expect(code).toContain(RED_FLAG_TRIGGER);

    const fix = renderStageFactsText(makeInputs(), 'p-1', 'fix');
    expect(fix).toContain(RED_FLAG_TRIGGER);

    const plan = renderStageFactsText(makeInputs(), 'p-1', 'plan');
    expect(plan).not.toContain(RED_FLAG_TRIGGER);

    const review = renderStageFactsText(makeInputs(), 'p-1', 'review');
    expect(review).not.toContain(RED_FLAG_TRIGGER);
  });

  it('keeps issue-bound facts out of pm jobs', () => {
    const pm = renderStageFactsText(makeInputs(), 'p-1', 'pm');
    expect(pm).not.toContain('Status ladder');
    expect(pm).not.toContain('Comment + status ordering');
    expect(pm).not.toContain('forge_step_handoff');
    // Tool-routing + guides index still apply.
    expect(pm).toContain('### Project integrations');
    expect(pm).toContain('Project guides (fetch on demand)');
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
    // Verbatim body present under the always-applied rules block.
    expect(text).toContain('### Project rules (always applied)');
    expect(text).toContain('#### contracts-boundary');
    expect(text).toContain(RULE);
    // The flagged key is NOT repeated in the fetch-on-demand pointer list…
    const indexSection = text.slice(text.indexOf('### Project guides (fetch on demand)'));
    expect(indexSection).not.toContain('- contracts-boundary');
    // …but a non-flagged guide still lists as a pointer.
    expect(indexSection).toContain('- build-commands');
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
    // …and the overflow is logged.
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
        environment: 'prod',
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
    expect(text).toContain('- **sentry** [prod] (health: ok)');
    expect(text).toContain('  - Backend: org=acme project=be — 5xx errors');
    expect(text).toContain('  - Mobile: org=acme project=mob');
  });

  it('renders just the bullet when a Sentry binding has no targets', () => {
    const text = renderIntegrations([
      { provider: 'sentry', environment: 'prod', lastHealthStatus: null, sentryTargets: [] },
    ]);
    expect(text).toContain('- **sentry** [prod]');
    expect(text).not.toContain('  - ');
  });
});

describe('renderIntegrations — capability-guide pointer (ISS-746)', () => {
  it('appends a forge_guide pointer on the same line for a provider with a seeded guide (coolify)', () => {
    const text = renderIntegrations([
      { provider: 'coolify', environment: 'staging', lastHealthStatus: 'ok' },
    ]);
    expect(text).toContain('Full guide: `forge_guide get deploy-safety`.');
    // Same bullet line, not a new line.
    expect(text).toContain(
      '- **coolify** [staging] (health: ok) — Deploy / redeploy and poll deployment status via the `forge_coolify_deploy` tool. Full guide: `forge_guide get deploy-safety`.',
    );
  });

  it('renders unchanged for a provider with no seeded guide (postman)', () => {
    const text = renderIntegrations([
      { provider: 'postman', environment: 'production', lastHealthStatus: null },
    ]);
    expect(text).not.toContain('Full guide:');
  });

  it('points at the org runtime guide for a provider that has no seeded slug (epodsystem)', () => {
    const text = renderIntegrations([
      {
        provider: 'epodsystem',
        environment: 'prod',
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
        environment: 'staging',
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
        environment: 'prod',
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
        environment: 'prod',
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
        environment: 'prod',
        lastHealthStatus: null,
        instructions: 'x',
      },
    ]);
    expect(text).toContain('follow these over the general guide where they conflict');
  });

  it('renders nothing extra for blank or whitespace-only instructions', () => {
    for (const instructions of [null, '', '   \n  ']) {
      const text = renderIntegrations([
        { provider: 'epodsystem', environment: 'prod', lastHealthStatus: null, instructions },
      ]);
      expect(text).not.toContain('Project-specific instructions');
    }
  });

  it('keeps both Sentry targets and instructions, targets first', () => {
    const text = renderIntegrations([
      {
        provider: 'sentry',
        environment: 'prod',
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
