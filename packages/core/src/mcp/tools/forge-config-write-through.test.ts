/**
 * ISS-1024 — `forge_config action=update` writes its `projectFacts` patch through to
 * `knowledge_entries` in ONE batched upsert, so a patch of N keys costs one embeddings call.
 *
 * It awaited `upsertKnowledgeEntry` once per key, which on the surface an agent reaches this
 * config through meant one embedding round-trip per fact in the patch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    KNOWLEDGE_INJECTION_ENABLED: true,
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const upsertKnowledgeEntriesMock = vi.fn(async (inputs: Array<{ slug: string }>) =>
  inputs.map((i) => ({ id: `id-${i.slug}`, slug: i.slug, degraded: false, truncated: false })),
);
const deleteKnowledgeEntryMock = vi.fn(async (_p: string, _s: string) => 1);
vi.mock('../../knowledge/service.js', () => ({
  upsertKnowledgeEntries: (inputs: unknown) => upsertKnowledgeEntriesMock(inputs as never),
  deleteKnowledgeEntry: (p: string, s: string) => deleteKnowledgeEntryMock(p, s),
}));

const agentConfig: { projectFacts: Record<string, string>; projectFactsConfig: unknown } = {
  projectFacts: {},
  projectFactsConfig: {},
};
vi.mock('../../projects/agent-config.js', () => ({
  readAgentConfig: async () => agentConfig,
  patchAgentConfigKey: async () => undefined,
  RETIRED_STATE_CONTEXT_MESSAGE: 'retired',
}));

vi.mock('../../projects/service.js', () => ({
  readProjectWithConfig: async () => ({
    id: PROJECT_ID,
    slug: 'p',
    name: 'P',
    repoPath: null,
    baseBranch: 'main',
    liveBranch: 'main',
    agentConfig: {},
  }),
  readIssueBranchInputs: async () => null,
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  },
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '88888888-8888-4888-8888-888888888888';

const { forgeConfigTool } = await import('./forge-config.js');

const principal = makeFakePrincipal(DEVICE_ID, OWNER_ID, { scopes: ['read', 'write', 'admin'] });
const tool = () => forgeConfigTool({ principal, projectSlug: null });

beforeEach(() => {
  upsertKnowledgeEntriesMock.mockClear();
  deleteKnowledgeEntryMock.mockClear();
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([{ orgId: ORG_ID, memberRole: 'admin', orgRole: null }]);
  agentConfig.projectFacts = {};
  agentConfig.projectFactsConfig = {};
});

describe('forge_config projectFacts write-through', () => {
  it('writes three keys in one batched upsert', async () => {
    await tool().handler({
      action: 'update',
      projectId: PROJECT_ID,
      projectFacts: { 'deploy-steps': 'a', 'gate-policy': 'b', 'master-policy': 'c' },
    });

    expect(upsertKnowledgeEntriesMock).toHaveBeenCalledTimes(1);
    const batch = upsertKnowledgeEntriesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(batch.map((b) => b.slug)).toEqual(['deploy-steps', 'gate-policy', 'master-policy']);
  });

  // cm:guard a key flagged `alwaysInject` carries `injection: 'always'`, which puts its FULL body
  // into every agent system prompt for the project — batching must not flatten that per-key choice
  it('keeps every key own injection mode inside the batch', async () => {
    agentConfig.projectFactsConfig = { 'gate-policy': { alwaysInject: true } };

    await tool().handler({
      action: 'update',
      projectId: PROJECT_ID,
      projectFacts: { 'deploy-steps': 'a', 'gate-policy': 'b' },
    });

    const batch = upsertKnowledgeEntriesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(batch.map((b) => [b.slug, b.injection])).toEqual([
      ['deploy-steps', 'on_demand'],
      ['gate-policy', 'always'],
    ]);
  });

  it('removes a key set to null and does not send it to the batch', async () => {
    await tool().handler({
      action: 'update',
      projectId: PROJECT_ID,
      projectFacts: { 'deploy-steps': 'a', 'gone-key': null },
    });

    expect(deleteKnowledgeEntryMock).toHaveBeenCalledWith(PROJECT_ID, 'gone-key');
    const batch = upsertKnowledgeEntriesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(batch.map((b) => b.slug)).toEqual(['deploy-steps']);
  });

  // cm:guard the reserved keys are DERIVED from the projects table columns, so a write-through
  // would mint a curated entry shadowing a value nobody set here
  it('sends no reserved key to the batch', async () => {
    await tool().handler({
      action: 'update',
      projectId: PROJECT_ID,
      projectFacts: { 'base-branch': 'main', 'deploy-steps': 'a' },
    });

    const batch = upsertKnowledgeEntriesMock.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(batch.map((b) => b.slug)).toEqual(['deploy-steps']);
  });

  it('makes no batched call when the patch is deletes only', async () => {
    await tool().handler({
      action: 'update',
      projectId: PROJECT_ID,
      projectFacts: { 'gone-key': null },
    });

    expect(upsertKnowledgeEntriesMock).not.toHaveBeenCalled();
  });
});
