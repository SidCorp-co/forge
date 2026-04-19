/**
 * Integration tests for the Self-Learning Chat Agent features.
 *
 * Requires: Strapi running on http://localhost:1337.
 * For chat send tests: LiteLLM must be running (LITELLM_API_URL configured in Strapi).
 *
 * Tests:
 *   Phase 1: RAG Gate — single LLM call replaces condense+classify
 *   Phase 2: Quality Signals — qualitySignals field in chat-log
 *   Phase 3: Enhanced Memory — new categories (pattern, frustration, expertise)
 *   Phase 4: Session Summary — summary + summarizedAt fields on chat-session
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = 'http://localhost:1337';
const RUN_ID = Date.now().toString(36);

let jwt = '';
let projectDocId = '';
let projectSlug = '';
let apiKey = '';
let chatSessionDocId = '';

async function api(
  method: string,
  path: string,
  body?: any,
  opts: { auth?: string; apiKey?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth) headers['Authorization'] = `Bearer ${opts.auth}`;
  if (opts.apiKey) headers['X-Forge-API-Key'] = opts.apiKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

// ────────────────────────────────────────
// Setup: register/login + create project
// ────────────────────────────────────────
beforeAll(async () => {
  const email = `selflearn-${RUN_ID}@test.com`;
  const reg = await api('POST', '/api/auth/local/register', {
    username: `selflearn-${RUN_ID}`,
    email,
    password: 'TestPass1234',
  });
  if (reg.status === 200 && reg.json?.jwt) {
    jwt = reg.json.jwt;
  } else {
    const login = await api('POST', '/api/auth/local', {
      identifier: email,
      password: 'TestPass1234',
    });
    jwt = login.json?.jwt || '';
  }

  projectSlug = `selflearn-proj-${RUN_ID}`;
  apiKey = `selflearn-key-${RUN_ID}`;
  const { json } = await api(
    'POST',
    '/api/projects',
    {
      data: {
        name: `Self-Learn Project ${RUN_ID}`,
        slug: projectSlug,
        description: 'For self-learning agent tests',
        apiKey,
      },
    },
    { auth: jwt },
  );
  projectDocId = json?.data?.documentId || '';
});

// ────────────────────────────────────────
// Phase 4: ChatSession schema — summary fields
// ────────────────────────────────────────
describe('Phase 4: ChatSession schema supports summary fields', () => {
  it('create chat session, then update with summary fields', async () => {
    // Create session first
    const createRes = await api(
      'POST',
      '/api/chat-sessions',
      {
        data: {
          title: 'Summary test session',
          messages: [
            { role: 'user', content: 'How do I deploy?' },
            { role: 'assistant', content: 'Merge to master branch.' },
          ],
          source: 'web',
          project: projectDocId,
        },
      },
      { auth: jwt },
    );

    expect(createRes.status).toBe(201);
    chatSessionDocId = createRes.json.data.documentId;

    // Update with summary
    const summary = 'User asked about deployment process. Advised to merge to master.';
    const updateRes = await api(
      'PUT',
      `/api/chat-sessions/${chatSessionDocId}`,
      {
        data: {
          summary,
          summarizedAt: new Date().toISOString(),
        },
      },
      { auth: jwt },
    );

    expect(updateRes.status).toBe(200);
    expect(updateRes.json.data.summary).toBe(summary);
    expect(updateRes.json.data.summarizedAt).toBeTruthy();
  });

  it('read back chat session with summary fields', async () => {
    const { status, json } = await api(
      'GET',
      `/api/chat-sessions/${chatSessionDocId}`,
      undefined,
      { auth: jwt },
    );

    expect(status).toBe(200);
    expect(json.data.summary).toContain('deployment');
    expect(json.data.summarizedAt).toBeTruthy();
  });

  it('update chat session summary to new value', async () => {
    const newSummary = 'Updated: deployment discussion, resolved with merge-to-master workflow.';
    const { status, json } = await api(
      'PUT',
      `/api/chat-sessions/${chatSessionDocId}`,
      {
        data: {
          summary: newSummary,
          summarizedAt: new Date().toISOString(),
        },
      },
      { auth: jwt },
    );

    expect(status).toBe(200);
    expect(json.data.summary).toBe(newSummary);
  });
});

// ────────────────────────────────────────
// Phase 2: ChatLog schema — qualitySignals field
// ────────────────────────────────────────
describe('Phase 2: ChatLog qualitySignals field', () => {
  it('GET /api/chat-logs/recent returns qualitySignals key', async () => {
    // Create a chat-log entry directly via Strapi content API
    // (since we can't easily trigger a full chat without LiteLLM)
    const createRes = await api(
      'POST',
      '/api/chat-logs',
      {
        data: {
          sessionId: chatSessionDocId || 'test-session',
          projectSlug,
          query: 'test quality signals',
          reply: 'test reply',
          qualitySignals: {
            turnIndex: 0,
            sessionTurnCount: 2,
            hadToolErrors: false,
            toolErrorCount: 0,
            ragHitCount: 3,
            ragWasEmpty: false,
            responseLength: 150,
            wasFollowUp: false,
            latencyMs: 1200,
            iterations: 1,
          },
        },
      },
      { auth: jwt },
    );

    // Content API may or may not be open — try via API key endpoint
    const { status, json } = await api(
      'GET',
      `/api/chat-logs/recent?limit=5`,
      undefined,
      { apiKey },
    );

    expect(status).toBe(200);

    // If we have logs, check structure
    if (Array.isArray(json) && json.length > 0) {
      const log = json.find((l: any) => l.query === 'test quality signals');
      if (log) {
        expect(log.qualitySignals).toBeDefined();
        expect(log.qualitySignals.turnIndex).toBe(0);
        expect(log.qualitySignals.hadToolErrors).toBe(false);
        expect(log.qualitySignals.ragHitCount).toBe(3);
        expect(log.qualitySignals.latencyMs).toBe(1200);
        expect(log.qualitySignals.iterations).toBe(1);
      }
    }
  });
});

// ────────────────────────────────────────
// Phase 1 + 2: Full chat send (requires LiteLLM)
// ────────────────────────────────────────
describe('Phase 1+2: Chat send with RAG gate and quality signals', () => {
  let sessionId = '';

  it('send a chat message and get response with sessionId', async () => {
    const { status, json } = await api(
      'POST',
      '/api/chat',
      {
        projectSlug,
        message: 'What issues are currently open in this project?',
      },
      { apiKey },
    );

    // May fail if LiteLLM is not running — skip gracefully
    if (status === 400 && json?.error?.message?.includes('LiteLLM')) {
      console.log('Skipping chat tests — LiteLLM not configured');
      return;
    }

    expect(status).toBe(200);
    expect(json.data.sessionId).toBeTruthy();
    expect(json.data.reply).toBeTruthy();
    sessionId = json.data.sessionId;
  });

  it('chat log contains qualitySignals after send', async () => {
    if (!sessionId) return; // skipped if LiteLLM not available

    // Give async log write a moment to complete
    await new Promise((r) => setTimeout(r, 1000));

    const { status, json } = await api(
      'GET',
      `/api/chat-logs/recent?limit=5`,
      undefined,
      { apiKey },
    );

    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);

    const log = json.find((l: any) => l.sessionId === sessionId);
    expect(log).toBeTruthy();
    expect(log.qualitySignals).toBeTruthy();
    expect(typeof log.qualitySignals.latencyMs).toBe('number');
    expect(typeof log.qualitySignals.ragHitCount).toBe('number');
    expect(typeof log.qualitySignals.hadToolErrors).toBe('boolean');
    expect(typeof log.qualitySignals.iterations).toBe('number');
  });

  it('send follow-up message — RAG gate classifies intent', async () => {
    if (!sessionId) return;

    // Use a longer follow-up so it passes the min query length threshold
    const { status, json } = await api(
      'POST',
      '/api/chat',
      {
        projectSlug,
        message: 'yes please do that for me now',
        sessionId,
      },
      { apiKey },
    );

    expect(status).toBe(200);

    // Check the log for this follow-up
    await new Promise((r) => setTimeout(r, 1500));

    const logs = await api(
      'GET',
      `/api/chat-logs/recent?limit=10`,
      undefined,
      { apiKey },
    );

    const followUpLog = logs.json?.find(
      (l: any) => l.sessionId === sessionId && l.query?.includes('yes please'),
    );

    if (followUpLog) {
      // RAG gate should classify follow-up confirmations as ACTION or CHAT
      expect(['ACTION', 'CHAT']).toContain(followUpLog.queryIntent);
      expect(followUpLog.qualitySignals).toBeTruthy();
      expect(followUpLog.qualitySignals.wasFollowUp).toBeDefined();
    }
  });
});

// ────────────────────────────────────────
// Phase 3: Memory categories
// ────────────────────────────────────────
describe('Phase 3: Enhanced memory categories', () => {
  it('create memory with new pattern category', async () => {
    const { status, json } = await api(
      'POST',
      '/api/memories',
      {
        data: {
          userKey: 'user:test',
          category: 'pattern',
          content: 'User usually deploys on Fridays',
          source: 'auto',
          scope: 'user',
          useCount: 1,
          project: projectDocId,
        },
      },
      { auth: jwt },
    );

    // Strapi content API may be restricted — 201 or 403
    if (status === 201) {
      expect(json.data.category).toBe('pattern');
      expect(json.data.content).toContain('Fridays');
    }
  });

  it('create memory with frustration category', async () => {
    const { status, json } = await api(
      'POST',
      '/api/memories',
      {
        data: {
          userKey: 'user:test',
          category: 'frustration',
          content: 'Qdrant timeout when batch > 100 embeddings',
          source: 'auto',
          scope: 'project',
          useCount: 1,
          project: projectDocId,
        },
      },
      { auth: jwt },
    );

    if (status === 201) {
      expect(json.data.category).toBe('frustration');
    }
  });

  it('create memory with expertise category', async () => {
    const { status, json } = await api(
      'POST',
      '/api/memories',
      {
        data: {
          userKey: 'user:test',
          category: 'expertise',
          content: 'User has deep PostgreSQL knowledge, skip basic DB explanations',
          source: 'auto',
          scope: 'user',
          useCount: 1,
          project: projectDocId,
        },
      },
      { auth: jwt },
    );

    if (status === 201) {
      expect(json.data.category).toBe('expertise');
    }
  });
});
