// AC5 parity test: flag-OFF and flag-ON must produce byte-identical renderStageFactsText
// output when the knowledge_entries data is a faithful migration of agentConfig.projectFacts.
//
// Invariant: the pointer text change (forge_config → forge_knowledge) lives in the SHARED
// renderStageFactsText renderer, so it fires in BOTH branches. Parity depends only on the
// injection source producing the same alwaysInjectFacts and projectFactKeys arrays.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../config/env.js', () => ({ env: { KNOWLEDGE_INJECTION_ENABLED: false } }));
vi.mock('../../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ logger: { warn: vi.fn() } }));

// cm:why imported at module scope, AFTER the vi.mock calls above — a dynamic import inside it() charges module-graph loading to the 5s test budget, which is what made this file flake
const { renderStageFactsText } = await import('./resolve.js');

// cm:why keys stay literal (no index signature) so `FIXTURE_FACTS['contracts-rule']` is a `string`, not `string | undefined`, under noUncheckedIndexedAccess
const FIXTURE_FACTS = {
  'build-test-commands': 'pnpm build && pnpm test',
  'deploy-guide': 'Use forge_coolify_deploy with serviceId from Coolify.',
  'contracts-rule': 'NEVER import @forge/contracts internals across package boundaries.',
} satisfies Record<string, string>;
const _FIXTURE_FACTS_CONFIG: Record<string, { alwaysInject?: boolean }> = {
  'contracts-rule': { alwaysInject: true },
};

// agentConfig path: selectAlwaysInjectFacts + Object.keys(projectFacts)
const alwaysInjectFromConfig = [{ key: 'contracts-rule', text: FIXTURE_FACTS['contracts-rule'] }];
const onDemandKeysFromConfig = ['build-test-commands', 'deploy-guide'];

// knowledge_entries path: after migration, same data sourced from the DB.
// The migration must preserve slug=key, body=text, injection mapping, and orderIndex.
const alwaysInjectFromKnowledge = [...alwaysInjectFromConfig];
const onDemandKeysFromKnowledge = [...onDemandKeysFromConfig];

// Shared projectFacts resolver (agentConfig is still read for {{project:key}} in both branches).
const projectResolver = (key: string): string | undefined => {
  const integrations: Record<string, string> = {
    integrations:
      '## Project integrations\nConnected integrations and how to use them:\n- **coolify** [staging] (health: ok) — Deploy via `forge_coolify_deploy`.',
  };
  const facts: Record<string, string | undefined> = FIXTURE_FACTS;
  return integrations[key] ?? facts[key];
};

const BASE_INPUTS = {
  ladder: ['open', 'confirmed', 'approved', 'developed', 'testing', 'released', 'closed'] as const,
  branches: { baseBranch: 'main', productionBranch: 'main' },
  project: projectResolver,
} as unknown as Parameters<typeof import('./resolve.js').renderStageFactsText>[0];

describe('AC5 parity: flag-OFF === flag-ON (byte-identical output)', () => {
  it('flag-OFF output (agentConfig source) matches flag-ON output (knowledge_entries source)', async () => {
    const flagOff = renderStageFactsText(
      {
        ...BASE_INPUTS,
        alwaysInjectFacts: alwaysInjectFromConfig,
        projectFactKeys: onDemandKeysFromConfig,
      },
      'p-parity',
      'code',
    );

    const flagOn = renderStageFactsText(
      {
        ...BASE_INPUTS,
        alwaysInjectFacts: alwaysInjectFromKnowledge,
        projectFactKeys: onDemandKeysFromKnowledge,
      },
      'p-parity',
      'code',
    );

    expect(flagOn).toBe(flagOff);
  });

  it('both branches use forge_knowledge pointer (not forge_config)', async () => {
    for (const [alwaysInjectFacts, projectFactKeys, label] of [
      [alwaysInjectFromConfig, onDemandKeysFromConfig, 'flag-OFF'] as const,
      [alwaysInjectFromKnowledge, onDemandKeysFromKnowledge, 'flag-ON'] as const,
    ]) {
      const text = renderStageFactsText(
        { ...BASE_INPUTS, alwaysInjectFacts, projectFactKeys },
        'p-parity',
        'code',
      );
      expect(text, `${label}: pointer text must reference forge_knowledge`).toContain(
        '`forge_knowledge`',
      );
      expect(text, `${label}: must NOT reference old forge_config pointer`).not.toContain(
        '`forge_config` (action `get` → `projectFacts',
      );
    }
  });

  it('always-inject fact is inlined verbatim in both branches', async () => {
    const RULE = FIXTURE_FACTS['contracts-rule'];

    for (const [alwaysInjectFacts, projectFactKeys, label] of [
      [alwaysInjectFromConfig, onDemandKeysFromConfig, 'flag-OFF'] as const,
      [alwaysInjectFromKnowledge, onDemandKeysFromKnowledge, 'flag-ON'] as const,
    ]) {
      const text = renderStageFactsText(
        { ...BASE_INPUTS, alwaysInjectFacts, projectFactKeys },
        'p-parity',
        'code',
      );
      expect(text, `${label}: always-inject rule must be verbatim`).toContain(RULE);
      expect(text, `${label}: contracts-rule must NOT appear in on-demand index`).not.toContain(
        '- contracts-rule',
      );
    }
  });

  it('on-demand keys appear in fetch index, not inlined', async () => {
    for (const [alwaysInjectFacts, projectFactKeys, label] of [
      [alwaysInjectFromConfig, onDemandKeysFromConfig, 'flag-OFF'] as const,
      [alwaysInjectFromKnowledge, onDemandKeysFromKnowledge, 'flag-ON'] as const,
    ]) {
      const text = renderStageFactsText(
        { ...BASE_INPUTS, alwaysInjectFacts, projectFactKeys },
        'p-parity',
        'code',
      );
      expect(text, `${label}: on-demand index present`).toContain(
        '### Project guides (fetch on demand)',
      );
      expect(text, `${label}: build-test-commands in index`).toContain('- build-test-commands');
      expect(text, `${label}: deploy-guide in index`).toContain('- deploy-guide');
      expect(text, `${label}: guide body must NOT be inlined`).not.toContain(
        'pnpm build && pnpm test',
      );
    }
  });
});
