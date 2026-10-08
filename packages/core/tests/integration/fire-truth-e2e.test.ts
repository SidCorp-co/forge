import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body } from '../helpers/api.js';
import { createTestRequirement } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// REQ-37 BC-9 on the page's own routes: a schedule script that read the project, and one that failed,
// are both listed on the schedule's Fires tab, and each fire the page opens says who ran it and what
// it read (refused reads included), by the person's name.

let w: World;

const make = async (script: string) => {
  const made = await api(w.token, 'POST', '/api/schedules', {
    projectId: w.projectId,
    name: `script ${randomUUID().slice(0, 8)}`,
    cron: '0 3 1 1 *',
    kind: 'script',
    script,
    enabled: false,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return String(made.body.id);
};
const base = () => `/api/projects/${w.projectId}/automation`;

beforeAll(async () => {
  w = await world();
  await createTestRequirement(w.projectId, 1, 'A person signs in');
}, 120_000);

describe('a script fire on the routes the fire page uses', () => {
  it('names who ran it and every read, a refused one included', async () => {
    const own = `/api/projects/${w.projectId}/requirements`;
    const id = await make(`
await ctx.forge.get(\`/api/projects/\${ctx.projectId}/requirements\`);
try { await ctx.forge.post(\`/api/projects/\${ctx.projectId}/requirements\`); } catch (e) { ctx.log(e.code); }
ctx.notify({ title: 'read', body: 'done' });`);
    const ran = await api(w.token, 'POST', `/api/schedules/${id}/run`);
    expect(ran.status, JSON.stringify(ran.body)).toBeLessThan(300);

    const list = await api(w.token, 'GET', `${base()}/schedules/${id}?firesLimit=20`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const fires = list.body.fires as Body[];
    expect(fires).toHaveLength(1);
    expect(list.body.firesTotal).toBe(1);

    const one = await api(w.token, 'GET', `${base()}/fires/${String(fires[0]?.id)}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const fire = one.body.fire as Body;
    expect(fire.status).toBe('success');
    expect(fire.runAs).toMatchObject({ id: w.userId });
    expect(String((fire.runAs as Body).name).length).toBeGreaterThan(0);
    expect(fire.reads).toEqual([
      { method: 'GET', path: own, status: 200 },
      { method: 'POST', path: own, status: null, refused: 'SCRIPT_READ_REFUSED' },
    ]);
    expect((fires[0] as Body).reads).toEqual(fire.reads);
  });

  it('lists a Run now whose script failed, with its error, on the Fires tab and the standing', async () => {
    const id = await make("throw new Error('boom from the script');");
    const ran = await api(w.token, 'POST', `/api/schedules/${id}/run`);
    expect(ran.status, JSON.stringify(ran.body)).toBe(422);
    expect(ran.body.code).toBe('SCHEDULE_RUN_FAILED');

    const list = await api(w.token, 'GET', `${base()}/schedules/${id}?firesLimit=20`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const fires = list.body.fires as Body[];
    expect(fires, JSON.stringify(list.body)).toHaveLength(1);
    expect(fires[0]).toMatchObject({ status: 'failed', trigger: 'manual' });
    expect(String(fires[0]?.error)).toContain('boom from the script');
    expect(fires[0]?.runAs).toMatchObject({ id: w.userId });
    expect(fires[0]?.reads).toEqual([]);
    expect(list.body.firesTotal).toBe(1);

    const standing = await api(w.token, 'GET', `${base()}/standing?firesLimit=50`);
    expect((standing.body.fires as Body[]).map((f) => f.id)).toContain(fires[0]?.id);
  });

  it('shows no one and no reads for a fire that ran no script', async () => {
    const made = await api(w.token, 'POST', '/api/schedules', {
      projectId: w.projectId,
      name: `prompt ${randomUUID().slice(0, 8)}`,
      cron: '0 3 1 1 *',
      prompt: 'say hi',
      enabled: false,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await api(w.token, 'POST', `/api/schedules/${String(made.body.id)}/run`);
    const list = await api(
      w.token,
      'GET',
      `${base()}/schedules/${String(made.body.id)}?firesLimit=20`,
    );
    for (const f of list.body.fires as Body[]) {
      expect(f.runAs).toBeNull();
      expect(f.reads).toBeNull();
    }
  });
});
