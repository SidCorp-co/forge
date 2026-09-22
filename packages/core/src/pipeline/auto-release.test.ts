/**
 * ISS-1189 — whether releasing is automatic is its own declaration, and `autoProdDeploy` is not it.
 * A project carrying `autoProdDeploy: true` and no release declaration does NOT release by itself,
 * which is what migration 0301 exists to prevent happening by accident: it writes the declaration
 * for every project that held the old key, so nothing's behaviour moves when this predicate does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let agentConfig: unknown = null;
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ agentConfig }] }) }),
    }),
  },
}));
// Only the table object is replaced: `issueStatuses` and the release vocabulary are read by the
// schema this module parses with, and a blanket mock would empty them.
vi.mock('../db/schema.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  projects: { agentConfig: {}, id: {} },
}));

const { projectReleasesAutomatically } = await import('./auto-release.js');

const withStates = (states: Record<string, unknown>) => ({
  pipelineConfig: { enabled: true, states },
});

describe('a project releases without a person only where it says so', () => {
  beforeEach(() => {
    agentConfig = null;
  });

  it('reads `auto` at awaiting_release as yes', async () => {
    agentConfig = withStates({ awaiting_release: { enabled: true, mode: 'auto' } });
    expect(await projectReleasesAutomatically('p')).toBe(true);
  });

  it('reads `manual` as no', async () => {
    agentConfig = withStates({ awaiting_release: { enabled: true, mode: 'manual' } });
    expect(await projectReleasesAutomatically('p')).toBe(false);
  });

  it('reads an absent mode as no — the issue stops at the rung and waits', async () => {
    agentConfig = withStates({ awaiting_release: { enabled: true } });
    expect(await projectReleasesAutomatically('p')).toBe(false);
  });

  it('reads a project with no pipeline config at all as no', async () => {
    agentConfig = null;
    expect(await projectReleasesAutomatically('p')).toBe(false);
  });

  it('does NOT read autoProdDeploy, which answers a different question', async () => {
    agentConfig = { pipelineConfig: { enabled: true, autoProdDeploy: true, states: {} } };
    expect(await projectReleasesAutomatically('p')).toBe(false);
  });

  it('is not talked into yes by `auto` at the entry status', async () => {
    agentConfig = withStates({ open: { enabled: true, mode: 'auto' } });
    expect(await projectReleasesAutomatically('p')).toBe(false);
  });
});
