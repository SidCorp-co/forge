// ISS-753: an issue read with no filter of its own still takes the `projectId` a display key in its
// path is resolved in (middleware/route-refs.ts), and refuses every other key by name.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { projectScopeQuery } from './issue-route-ref.js';

const app = new Hono().get('/:id/criteria', projectScopeQuery, (c) => c.json({ ok: true }));
const PROJECT = 'd1bb4907-74d9-4228-85ff-76121523af7d';

describe('projectScopeQuery', () => {
  it('takes projectId, and no query at all', async () => {
    expect((await app.request(`/ISS-7/criteria?projectId=${PROJECT}`)).status).toBe(200);
    expect((await app.request('/ISS-7/criteria')).status).toBe(200);
  });

  it('refuses another key by name, listing projectId as the one it takes', async () => {
    const res = await app.request(`/ISS-7/criteria?projectId=${PROJECT}&revision=3`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'Unknown query parameter: `revision`. This route takes: projectId.',
    );
  });
});
