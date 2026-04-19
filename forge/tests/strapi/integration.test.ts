/**
 * Integration tests against a live Strapi instance.
 *
 * Requires: Strapi running on http://localhost:1337 with a clean DB.
 * Run:  npx vitest run src/__tests__/integration.test.ts
 *
 * Tests the real data flow:
 *   Register → Project → Issue → Comment → Task → ChatSession
 *   Widget (API key) → Issue → Comment → ChatSession
 *   Lifecycle: complete all tasks → auto-resolve issue
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = 'http://localhost:1337';

// Unique suffix to allow reruns without clean DB
const RUN_ID = Date.now().toString(36);

// Shared state across ordered tests
let jwt = '';
let projectDocId = '';
let apiKey = '';
let issueDocId = '';
let taskDocId = '';
let widgetIssueDocId = '';

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
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: res.status, json, text };
}

// ────────────────────────────────────────
// Auth
// ────────────────────────────────────────
describe('Auth', () => {
  it('register or login a test user and receive JWT', async () => {
    const email = `integration-${RUN_ID}@test.com`;
    const reg = await api('POST', '/api/auth/local/register', {
      username: `integrationuser-${RUN_ID}`,
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
      expect(login.status).toBe(200);
      expect(login.json.jwt).toBeTruthy();
      jwt = login.json.jwt;
    }

    expect(jwt).toBeTruthy();
  });

  it('unauthenticated GET /api/projects returns 401', async () => {
    const { status } = await api('GET', '/api/projects');
    expect(status).toBe(401);
  });
});

// ────────────────────────────────────────
// Project CRUD (auth required)
// ────────────────────────────────────────
describe('Project', () => {
  it('create project', async () => {
    const { status, json } = await api(
      'POST',
      '/api/projects',
      {
        data: {
          name: `Integration Project ${RUN_ID}`,
          slug: `integration-proj-${RUN_ID}`,
          description: 'For integration tests',
          apiKey: `int-test-api-key-${RUN_ID}`,
        },
      },
      { auth: jwt },
    );

    expect(status).toBe(201);
    expect(json.data.documentId).toBeTruthy();
    expect(json.data.name).toBe(`Integration Project ${RUN_ID}`);
    projectDocId = json.data.documentId;
    apiKey = `int-test-api-key-${RUN_ID}`;
  });

  it('list projects (authenticated)', async () => {
    const { status, json } = await api('GET', '/api/projects', undefined, { auth: jwt });
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  it('get single project', async () => {
    const { status, json } = await api('GET', `/api/projects/${projectDocId}`, undefined, {
      auth: jwt,
    });
    expect(status).toBe(200);
    expect(json.data.slug).toBe(`integration-proj-${RUN_ID}`);
  });

  it('update project', async () => {
    const { status, json } = await api(
      'PUT',
      `/api/projects/${projectDocId}`,
      { data: { description: 'Updated description' } },
      { auth: jwt },
    );
    expect(status).toBe(200);
    expect(json.data.description).toBe('Updated description');
  });
});

// ────────────────────────────────────────
// Issue (auth flow)
// ────────────────────────────────────────
describe('Issue (authenticated)', () => {
  it('create issue with project relation', async () => {
    const { status, json } = await api(
      'POST',
      '/api/issues',
      {
        data: {
          title: 'Login button broken',
          description: 'Users cannot click the login button on mobile',
          project: projectDocId,
          reportedBy: 'integrationuser',
        },
      },
      { auth: jwt },
    );

    expect(status).toBe(201);
    expect(json.data.documentId).toBeTruthy();
    expect(json.data.title).toBe('Login button broken');
    expect(json.data.status).toBe('open');
    expect(json.data.priority).toBe('none');
    issueDocId = json.data.documentId;
  });

  it('create issue without title returns 400', async () => {
    const { status } = await api(
      'POST',
      '/api/issues',
      { data: { description: 'No title here' } },
      { auth: jwt },
    );
    expect(status).toBe(400);
  });

  it('list issues', async () => {
    const { status, json } = await api('GET', '/api/issues', undefined, { auth: jwt });
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  it('get issue with project populated', async () => {
    const { status, json } = await api(
      'GET',
      `/api/issues/${issueDocId}?populate=project`,
      undefined,
      { auth: jwt },
    );
    expect(status).toBe(200);
    expect(json.data.project.documentId).toBe(projectDocId);
  });

  it('update issue status to confirmed', async () => {
    const { status, json } = await api(
      'PUT',
      `/api/issues/${issueDocId}`,
      { data: { status: 'confirmed' } },
      { auth: jwt },
    );
    expect(status).toBe(200);
    expect(json.data.status).toBe('confirmed');
  });
});

// ────────────────────────────────────────
// Comment (auth flow)
// ────────────────────────────────────────
describe('Comment (authenticated)', () => {
  it('create comment on issue', async () => {
    const { status, json } = await api(
      'POST',
      '/api/comments',
      {
        data: {
          body: 'I can reproduce this on iPhone 14',
          author: 'integrationuser',
          issue: issueDocId,
        },
      },
      { auth: jwt },
    );

    expect(status).toBe(201);
    expect(json.data.body).toBe('I can reproduce this on iPhone 14');
  });

  it('create comment without body returns 400', async () => {
    const { status } = await api(
      'POST',
      '/api/comments',
      { data: { author: 'user' } },
      { auth: jwt },
    );
    expect(status).toBe(400);
  });

  it('list comments', async () => {
    const { status, json } = await api('GET', '/api/comments', undefined, { auth: jwt });
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────
// Task (auth required, dev-facing)
// ────────────────────────────────────────
describe('Task (authenticated)', () => {
  it('create task linked to issue and project', async () => {
    const { status, json } = await api(
      'POST',
      '/api/tasks',
      {
        data: {
          title: 'Fix mobile login button CSS',
          description: 'The button z-index is wrong on mobile viewports',
          status: 'backlog',
          priority: 'high',
          isAgentTask: true,
          agentStatus: 'idle',
          issue: issueDocId,
          project: projectDocId,
        },
      },
      { auth: jwt },
    );

    expect(status).toBe(201);
    expect(json.data.documentId).toBeTruthy();
    expect(json.data.title).toBe('Fix mobile login button CSS');
    expect(json.data.status).toBe('backlog');
    taskDocId = json.data.documentId;
  });

  it('unauthenticated POST /api/tasks returns 401', async () => {
    const { status } = await api('POST', '/api/tasks', {
      data: { title: 'Should fail' },
    });
    expect(status).toBe(401);
  });

  it('list tasks', async () => {
    const { status, json } = await api('GET', '/api/tasks', undefined, { auth: jwt });
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  it('get task with issue populated', async () => {
    const { status, json } = await api(
      'GET',
      `/api/tasks/${taskDocId}?populate=issue`,
      undefined,
      { auth: jwt },
    );
    expect(status).toBe(200);
    expect(json.data.issue.documentId).toBe(issueDocId);
  });

  it('update task status', async () => {
    const { status, json } = await api(
      'PUT',
      `/api/tasks/${taskDocId}`,
      { data: { status: 'in_progress' } },
      { auth: jwt },
    );
    expect(status).toBe(200);
    expect(json.data.status).toBe('in_progress');
  });
});

// ────────────────────────────────────────
// ChatSession (auth flow)
// ────────────────────────────────────────
describe('ChatSession (authenticated)', () => {
  it('create chat session with project', async () => {
    const { status, json } = await api(
      'POST',
      '/api/chat-sessions',
      {
        data: {
          title: 'Auth chat session',
          messages: [
            { role: 'user', content: 'Help me with login' },
            { role: 'assistant', content: 'Sure, what browser are you using?' },
          ],
          source: 'web',
          project: projectDocId,
        },
      },
      { auth: jwt },
    );

    expect(status).toBe(201);
    expect(json.data.title).toBe('Auth chat session');
  });

  it('list chat sessions', async () => {
    const { status, json } = await api('GET', '/api/chat-sessions', undefined, { auth: jwt });
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────
// Widget flow (API key, no JWT)
// ────────────────────────────────────────
describe('Widget (API key)', () => {
  it('unauthenticated POST without API key returns 401', async () => {
    const { status } = await api('POST', '/api/issues', {
      data: { title: 'No auth at all' },
    });
    expect(status).toBe(401);
  });

  it('invalid API key returns error', async () => {
    const { status } = await api(
      'POST',
      '/api/issues',
      { data: { title: 'Bad key' } },
      { apiKey: 'totally-wrong-key' },
    );
    // Policy throws PolicyError -> 403
    expect([401, 403]).toContain(status);
  });

  it('create issue via API key (auto-attaches project)', async () => {
    const { status, json } = await api(
      'POST',
      '/api/issues',
      {
        data: {
          title: 'Widget: page not loading',
          description: 'The dashboard page shows a blank screen',
          reportedBy: 'anonymous-widget-user',
        },
      },
      { apiKey },
    );

    expect(status).toBe(201);
    expect(json.data.title).toBe('Widget: page not loading');
    expect(json.data.status).toBe('open');
    widgetIssueDocId = json.data.documentId;
  });

  it('widget issue is linked to the correct project', async () => {
    // Need JWT to read the issue with populate
    const { status, json } = await api(
      'GET',
      `/api/issues/${widgetIssueDocId}?populate=project`,
      undefined,
      { auth: jwt },
    );
    expect(status).toBe(200);
    expect(json.data.project.documentId).toBe(projectDocId);
  });

  it('create comment via API key with issue relation', async () => {
    const { status, json } = await api(
      'POST',
      '/api/comments',
      {
        data: {
          body: 'I see this on Chrome 120',
          author: 'widget-visitor',
          issue: widgetIssueDocId,
        },
      },
      { apiKey },
    );

    expect(status).toBe(201);
    expect(json.data.body).toBe('I see this on Chrome 120');
  });

  it('widget comment is linked to the issue', async () => {
    const { status, json } = await api(
      'GET',
      `/api/issues/${widgetIssueDocId}?populate=comments`,
      undefined,
      { auth: jwt },
    );
    expect(status).toBe(200);
    const widgetComment = json.data.comments.find(
      (c: any) => c.author === 'widget-visitor',
    );
    expect(widgetComment).toBeTruthy();
    expect(widgetComment.body).toBe('I see this on Chrome 120');
  });

  it('create chat session via API key', async () => {
    const { status, json } = await api(
      'POST',
      '/api/chat-sessions',
      {
        data: {
          title: 'Widget chat',
          messages: [{ role: 'user', content: 'Hello from widget' }],
          source: 'widget',
          metadata: { url: 'https://example.com/help' },
        },
      },
      { apiKey },
    );

    expect(status).toBe(201);
    expect(json.data.title).toBe('Widget chat');
  });

  it('widget can list issues via API key', async () => {
    const { status, json } = await api('GET', '/api/issues', undefined, { apiKey });
    expect(status).toBe(200);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  it('widget can create tasks via API key', async () => {
    const { status, json } = await api(
      'POST',
      '/api/tasks',
      { data: { title: 'Widget task', status: 'backlog' } },
      { apiKey },
    );
    expect(status).toBe(201);
    expect(json.data.title).toBe('Widget task');
  });
});

// ────────────────────────────────────────
// Lifecycle: all tasks done → issue resolved
// ────────────────────────────────────────
describe('Lifecycle: task completion → issue resolution', () => {
  let resolutionIssueDocId = '';
  let taskIds: string[] = [];

  it('setup: create issue and manual tasks', async () => {
    const { json: issueJson } = await api(
      'POST',
      '/api/issues',
      {
        data: {
          title: 'Resolution test issue',
          description: 'Test auto resolution',
          status: 'approved',
          project: projectDocId,
        },
      },
      { auth: jwt },
    );
    resolutionIssueDocId = issueJson.data.documentId;

    // Create 2 tasks manually
    for (const title of ['Task A', 'Task B']) {
      const { json } = await api(
        'POST',
        '/api/tasks',
        {
          data: {
            title,
            status: 'backlog',
            issue: resolutionIssueDocId,
            project: projectDocId,
          },
        },
        { auth: jwt },
      );
      taskIds.push(json.data.documentId);
    }
  });

  it('completing one task does not resolve the issue', async () => {
    await api(
      'PUT',
      `/api/tasks/${taskIds[0]}`,
      { data: { status: 'done' } },
      { auth: jwt },
    );

    await new Promise((r) => setTimeout(r, 300));

    const { json } = await api('GET', `/api/issues/${resolutionIssueDocId}`, undefined, {
      auth: jwt,
    });
    // Issue should still be approved, not closed
    expect(json.data.status).not.toBe('closed');
  });

  it('completing all tasks auto-resolves the issue', async () => {
    await api(
      'PUT',
      `/api/tasks/${taskIds[1]}`,
      { data: { status: 'done' } },
      { auth: jwt },
    );

    await new Promise((r) => setTimeout(r, 300));

    const { json } = await api('GET', `/api/issues/${resolutionIssueDocId}`, undefined, {
      auth: jwt,
    });
    expect(json.data.status).toBe('closed');
  });
});

// ────────────────────────────────────────
// Delete operations (auth only)
// ────────────────────────────────────────
describe('Delete operations', () => {
  it('authenticated user can delete a task', async () => {
    const { json: createJson } = await api(
      'POST',
      '/api/tasks',
      { data: { title: 'To be deleted', status: 'backlog' } },
      { auth: jwt },
    );
    const docId = createJson.data.documentId;

    const { status } = await api('DELETE', `/api/tasks/${docId}`, undefined, { auth: jwt });
    expect(status).toBe(204);
  });

  it('authenticated user can delete a comment', async () => {
    const { json: createJson } = await api(
      'POST',
      '/api/comments',
      { data: { body: 'To be deleted', author: 'test' } },
      { auth: jwt },
    );
    const docId = createJson.data.documentId;

    const { status } = await api('DELETE', `/api/comments/${docId}`, undefined, { auth: jwt });
    expect(status).toBe(204);
  });

  it('unauthenticated cannot delete issue', async () => {
    expect(issueDocId).toBeTruthy();
    const { status } = await api('DELETE', `/api/issues/${issueDocId}`);
    expect(status).toBe(401);
  });
});
