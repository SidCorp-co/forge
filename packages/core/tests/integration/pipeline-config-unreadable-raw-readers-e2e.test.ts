/**
 * ISS-1368 — the readers that take one key of a project's stored `pipelineConfig` and fall back to a
 * default refuse the document by name where the schema refuses it, rather than reading a key of a
 * document the refusal says nothing reads. Real Postgres, the document stored as a project stores it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { expectNamed, REFUSED, refusalOf } from '../helpers/refused-pipeline-config.js';

let harness: TestDatabase;
let refusedId: string;
let ownerId: string;

const named = (said: string) => expectNamed(said, refusedId);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 180_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  refusedId = (
    await createTestProject(harness.db, ownerId, {
      orgId: org.id,
      agentConfig: { pipelineConfig: REFUSED },
    })
  ).id;
});

describe('a one-key reader refuses a stored pipelineConfig the schema refuses, by name', () => {
  it('the intake gate', async () => {
    const { resolveIntakeGate } = await import('../../src/issues/intake-gate.js');
    named(await refusalOf(() => resolveIntakeGate(refusedId)));
  });

  it("names the refusal at error when a gated issue's intake is finalized", async () => {
    const { finalizeIntake } = await import('../../src/issues/intake-gate.js');
    const { logger } = await import('../../src/logger.js');
    const logged = vi.spyOn(logger, 'error');

    await finalizeIntake(refusedId, { id: randomUUID(), title: 'gated' });

    named(String(logged.mock.calls.find((c) => String(c[1]).includes(refusedId))?.[1]));
    logged.mockRestore();
  });

  it("a dispatch's stage overrides, and the per-state MCP names", async () => {
    const stages = await import('../../src/jobs/stage-overrides.js');
    named(await refusalOf(() => stages.resolveStageOverrides(refusedId, { stageStatus: 'open' })));
    named(await refusalOf(() => stages.stateDeclaredMcpNames(refusedId)));
  });

  it("the project's default MCP servers", async () => {
    const { resolveProjectDefaultMcpServers } = await import('../../src/jobs/stage-overrides.js');
    named(await refusalOf(() => resolveProjectDefaultMcpServers(refusedId)));
  });

  it("a claimed job's session settings", async () => {
    const { sessionSettingsOf } = await import('../../src/jobs/prepare-claimed-job.js');
    named(await refusalOf(() => sessionSettingsOf(refusedId)));
  });

  it('the resume bounds, read or handed the agent config', async () => {
    const { loadResumeBounds } = await import('../../src/jobs/session-resume.js');
    named(await refusalOf(() => loadResumeBounds(refusedId)));
    named(await refusalOf(() => loadResumeBounds(refusedId, { pipelineConfig: REFUSED })));
  });

  it('knowledge promotion', async () => {
    const { resolveKnowledgePromotion } = await import('../../src/memory/knowledge-promotion.js');
    named(await refusalOf(() => resolveKnowledgePromotion(refusedId)));
  });

  it('the automatic production deploy flag', async () => {
    const { projectAutoProdDeploy } = await import('../../src/pipeline/auto-prod-deploy.js');
    named(await refusalOf(() => projectAutoProdDeploy(refusedId)));
  });

  it('the weekly assistant, and the projects opted into it', async () => {
    const weekly = await import('../../src/assistant/weekly/config.js');
    named(await refusalOf(() => weekly.resolveAssistantWeekly(refusedId)));
    const weeklyOn = {
      enabled: true,
      pinnedIssue: 'ISS-1',
      judgeProviderId: 'judge',
      judgeModel: 'model',
    };
    const soundId = (
      await createTestProject(harness.db, ownerId, {
        agentConfig: { pipelineConfig: { assistantWeekly: weeklyOn } },
      })
    ).id;
    const refused: Array<{ projectId: string; message: string }> = [];

    const listed = await weekly.listOptedInProjects(undefined, refused);

    expect(listed.map((p) => p.projectId)).toEqual([soundId]);
    expect(refused.map((r) => r.projectId)).toEqual([refusedId]);
    named(refused[0]?.message ?? '');
  });

  it("a conversation turn's external MCP servers", async () => {
    const { buildExternalMcpToolsets } = await import('../../src/assistant/tools/external-mcp.js');
    const agentConfig = { pipelineConfig: REFUSED };
    named(await refusalOf(() => buildExternalMcpToolsets(refusedId, agentConfig)));
  });

  it("a prompt's project facts", async () => {
    const { loadProjectFactInputs } = await import('../../src/prompt/facts/resolve.js');
    named(await refusalOf(() => loadProjectFactInputs(refusedId)));
  });
});
