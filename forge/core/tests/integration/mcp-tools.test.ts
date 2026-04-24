import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Phase 2.5-F4 integration — MCP tools end-to-end. Device-authed clients
// connect via InMemoryTransport (same machinery MCP uses, but loopback) and
// exercise tools/list + tools/call against real Postgres with pgvector.
// Embeddings service is stubbed so no external LiteLLM needed.

const DIM = 1536;

function hotVector(hotIdx: number, mag = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[hotIdx] = mag;
  return v;
}

describe('F4 MCP tools integration', () => {
  let harness: TestDatabase;
  let issueDeviceToken: typeof import('../../src/auth/deviceToken.js').issueDeviceToken;
  let verifyDeviceToken: typeof import('../../src/auth/deviceToken.js').verifyDeviceToken;
  let createMcpServer: typeof import('../../src/mcp/server.js').createMcpServer;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

    const serverMod = await import('../../src/mcp/server.js');
    const deviceTokenMod = await import('../../src/auth/deviceToken.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    createMcpServer = serverMod.createMcpServer;
    issueDeviceToken = deviceTokenMod.issueDeviceToken;
    verifyDeviceToken = deviceTokenMod.verifyDeviceToken;
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedProject(role: 'owner' | 'admin' | 'member') {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role,
    });
    return { user, project };
  }

  async function connectClientAsDevice(deviceToken: string) {
    const device = await verifyDeviceToken(deviceToken);
    if (!device) throw new Error('test device token did not verify');
    const server = createMcpServer(device);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return {
      client,
      server,
      device,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  function stubEmbedding(vec: number[]) {
    const fake = {
      embed: vi.fn(async () => vec),
      embedBatch: vi.fn(async () => [vec]),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );
  }

  async function insertMemory(
    projectId: string,
    opts: { source: string; sourceRef: string; text: string; vec: number[] },
  ): Promise<void> {
    const vecLiteral = `[${opts.vec.join(',')}]`;
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding, metadata)
      VALUES (${projectId}, ${opts.source}, ${opts.sourceRef}, ${opts.text}, ${vecLiteral}::vector, '{}'::jsonb)
    `);
  }

  async function insertSkill(
    projectId: string | null,
    name: string,
    scope: 'global' | 'project' = 'project',
  ): Promise<string> {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO skills (name, description, scope, project_id, prompt, tools, source, content_hash)
      VALUES (
        ${name},
        'desc',
        ${scope},
        ${projectId},
        'body',
        '[]'::jsonb,
        'user',
        ${`h-${name}-${randomUUID().slice(0, 8)}`}
      )
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  function parseToolResult(res: { content: Array<{ type: string; text: string }> }): unknown {
    const first = res.content[0];
    if (!first || first.type !== 'text') throw new Error('expected text content');
    return JSON.parse(first.text);
  }

  // ---------- tools/list ----------

  it('tools/list: returns the five tools with input schemas', async () => {
    const { user } = await seedProject('owner');
    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = await ctx.client.listTools();
      const names = res.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'forge_memory.search',
          'forge_skills.get',
          'forge_skills.list',
          'forge_skills.register',
          'forge_version',
        ].sort(),
      );
      for (const t of res.tools) {
        expect(t.inputSchema).toBeTruthy();
      }
    } finally {
      await ctx.close();
    }
  });

  // ---------- forge_memory.search ----------

  it('forge_memory.search: happy path returns hits', async () => {
    const { user, project } = await seedProject('owner');
    await insertMemory(project.id, {
      source: 'issue',
      sourceRef: randomUUID(),
      text: 'login flow',
      vec: hotVector(0),
    });
    stubEmbedding(hotVector(0));

    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = await ctx.client.callTool({
        name: 'forge_memory.search',
        arguments: { projectId: project.id, query: 'login', topK: 3 },
      });
      expect(res.isError).not.toBe(true);
      const parsed = parseToolResult(res as never) as {
        hits: Array<{ text: string }>;
        model: string;
      };
      expect(parsed.hits).toHaveLength(1);
      expect(parsed.hits[0]?.text).toBe('login flow');
      expect(parsed.model).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  it('forge_memory.search: device not on project → FORBIDDEN via isError', async () => {
    const { project } = await seedProject('owner');
    const stranger = await createTestUser(harness.db);
    const { plaintext } = await issueDeviceToken({
      ownerId: stranger.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_memory.search',
        arguments: { projectId: project.id, query: 'x' },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/FORBIDDEN/);
    } finally {
      await ctx.close();
    }
  });

  it('forge_memory.search: invalid arguments → isError (zod parse)', async () => {
    const { user } = await seedProject('owner');
    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_memory.search',
        arguments: { query: 'missing projectId' },
      })) as { isError?: boolean };
      expect(res.isError).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  // ---------- forge_skills.list / get ----------

  it('forge_skills.list: returns global + project-scoped skills only', async () => {
    const { user, project } = await seedProject('owner');
    const otherProject = await createTestProject(harness.db, user.id, { slug: 'other' });
    await insertSkill(null, 'forge-plan', 'global');
    await insertSkill(project.id, 'project-a-custom', 'project');
    await insertSkill(otherProject.id, 'project-b-custom', 'project');

    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = await ctx.client.callTool({
        name: 'forge_skills.list',
        arguments: { projectId: project.id },
      });
      const parsed = parseToolResult(res as never) as {
        skills: Array<{ name: string; scope: string; projectId: string | null }>;
      };
      const names = parsed.skills.map((s) => s.name).sort();
      expect(names).toEqual(['forge-plan', 'project-a-custom']);
    } finally {
      await ctx.close();
    }
  });

  it('forge_skills.get: returns null for foreign project-scoped skill', async () => {
    const { user, project } = await seedProject('owner');
    const otherProject = await createTestProject(harness.db, user.id, { slug: 'other2' });
    const foreignSkillId = await insertSkill(otherProject.id, 'foreign', 'project');

    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = await ctx.client.callTool({
        name: 'forge_skills.get',
        arguments: { projectId: project.id, skillId: foreignSkillId },
      });
      const parsed = parseToolResult(res as never) as { skill: unknown };
      expect(parsed.skill).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  // ---------- forge_skills.register ----------

  it('forge_skills.register: admin device succeeds', async () => {
    const { user, project } = await seedProject('owner');
    const skillId = await insertSkill(project.id, 'r-skill');
    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = await ctx.client.callTool({
        name: 'forge_skills.register',
        arguments: { projectId: project.id, skillId, stage: 'approved' },
      });
      expect(res.isError).not.toBe(true);
      const parsed = parseToolResult(res as never) as { stage: string };
      expect(parsed.stage).toBe('approved');

      const rows = await harness.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM skill_registrations WHERE project_id = ${project.id}`,
      );
      expect((rows[0] as { count: string }).count).toBe('1');
    } finally {
      await ctx.close();
    }
  });

  it('forge_skills.register: member device → FORBIDDEN isError', async () => {
    const owner = await seedProject('owner');
    const memberUser = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: memberUser.id,
      projectId: owner.project.id,
      role: 'member',
    });
    const skillId = await insertSkill(owner.project.id, 'r2');
    const { plaintext } = await issueDeviceToken({
      ownerId: memberUser.id,
      name: 'member-dev',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_skills.register',
        arguments: { projectId: owner.project.id, skillId, stage: 'approved' },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/FORBIDDEN/);
    } finally {
      await ctx.close();
    }
  });

  it('forge_skills.register: unknown skill → NOT_FOUND isError', async () => {
    const { user, project } = await seedProject('owner');
    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_skills.register',
        arguments: {
          projectId: project.id,
          skillId: '00000000-0000-4000-8000-000000000000',
          stage: 'approved',
        },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/NOT_FOUND/);
    } finally {
      await ctx.close();
    }
  });

  it('forge_skills.register: stage=null clears the binding', async () => {
    const { user, project } = await seedProject('owner');
    const skillId = await insertSkill(project.id, 'r3');
    const { plaintext } = await issueDeviceToken({
      ownerId: user.id,
      name: 'd',
      platform: 'linux',
    });
    const ctx = await connectClientAsDevice(plaintext);
    try {
      await ctx.client.callTool({
        name: 'forge_skills.register',
        arguments: { projectId: project.id, skillId, stage: 'approved' },
      });
      const res = await ctx.client.callTool({
        name: 'forge_skills.register',
        arguments: { projectId: project.id, skillId, stage: null },
      });
      const parsed = parseToolResult(res as never) as { stage: string | null };
      expect(parsed.stage).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
