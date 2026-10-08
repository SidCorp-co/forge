import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildChatToolContext } from '../../src/assistant/tools/principal.js';
import { mintPat } from '../../src/credentials/pat.js';
import { CHAT_TURN_MENU, mintTurnCredential } from '../../src/credentials/turn-credential.js';
import { db } from '../../src/db/client.js';
import { resolveTurnAuthority } from '../../src/permissions/index.js';
import { forgeComputeTool } from '../../src/reports/tool.js';
import { api, type Body } from '../helpers/api.js';
import { createTestIssue, createTestProject, createTestRequirement } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// One script sandbox (REQ-37, REQ-32 BC-16), driven end to end on a real database through core's own
// REST app: a chat computation reads the project's requirement list by GET as the asker and returns
// frames; a write, another project's path or another project's issue is refused, by name or by the
// token's fence; a GET the asker's own grant does not cover answers 403; a schedule script still
// notifies, now reading Forge too; every run records who ran it and what it read, and its read token
// is revoked once it ends.

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>) => [...(await db.execute(q))] as Row[];

let w: World;
let other: { id: string };
let otherIssue: string;
let ownIssue: string;
let roomId: string;

const listScript = `
const { requirements } = await ctx.forge.get(\`/api/projects/\${ctx.projectId}/requirements\`);
ctx.log('read', requirements.length, 'requirements');
return {
  frames: [{
    fields: [{ name: 'title', type: 'string', label: 'Requirement' }],
    rows: requirements.map((r) => ({ title: r.title })).sort((a, b) => a.title.localeCompare(b.title)),
  }],
};`;

const scriptTokens = (userId: string) =>
  rows(sql`
    SELECT name, revoked_at, scopes, permissions, bound_project_id FROM personal_access_tokens
    WHERE user_id = ${userId} AND name LIKE 'script read %' ORDER BY created_at
  `);

beforeAll(async () => {
  w = await world();
  other = await createTestProject(w.userId);
  otherIssue = (
    await createTestIssue(other.id, w.userId, 1, { status: 'open', createdAt: new Date() })
  ).id;
  await createTestRequirement(w.projectId, 1, 'A person signs in');
  await createTestRequirement(w.projectId, 2, 'A person signs out');
  ownIssue = (
    await createTestIssue(w.projectId, w.userId, 1, { status: 'open', createdAt: new Date() })
  ).id;
  await seedProjectDocument(w.projectId, w.userId, {
    environments: {},
    extra: { compute: { enabled: true } },
  });
  const opened = await api(w.token, 'POST', '/api/conversations', {
    projectId: w.projectId,
    title: 'what no report says',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  roomId = String(opened.body.id);
}, 120_000);

describe('a chat computation', () => {
  it('reads the project requirement list by GET as the asker and returns frames, recorded and shown', async () => {
    const resolved = await resolveTurnAuthority({
      userId: w.userId,
      projectId: w.projectId,
      viaTokenId: null,
    });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    const credential = await mintTurnCredential({
      authority: resolved.authority,
      menu: CHAT_TURN_MENU,
      ttlMs: 10 * 60_000,
    });
    const tool = forgeComputeTool(
      buildChatToolContext({
        credential,
        projectSlug: 'sandbox',
        turn: { conversationId: roomId, speakerUserId: w.userId, handleUserId: null },
      }),
    );
    const answer = (await tool.handler({
      projectId: w.projectId,
      language: 'javascript',
      script: listScript,
      inputs: [],
    })) as Body;

    expect(answer.error, JSON.stringify(answer)).toBeUndefined();
    expect(answer.adapter).toBe('forge-sandbox');
    expect(answer.frames).toEqual([
      {
        fields: [{ name: 'title', type: 'string', label: 'Requirement' }],
        rows: [{ title: 'A person signs in' }, { title: 'A person signs out' }],
      },
    ]);
    expect((answer.logs as Body).stdout).toBe('read 2 requirements');
    const path = `/api/projects/${w.projectId}/requirements`;
    expect(answer.reads).toEqual([{ method: 'GET', path, status: 200 }]);

    const [kept] = await rows(sql`
      SELECT asked_by, language, script, reads FROM report_executions WHERE id = ${String(answer.executionId)}
    `);
    expect(kept).toEqual({
      asked_by: w.userId,
      language: 'javascript',
      script: listScript,
      reads: [{ method: 'GET', path, status: 200 }],
    });

    // the read token was the asker's, read-only, fenced to the project, and is revoked now the run is over
    const tokens = await scriptTokens(w.userId);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      scopes: ['read'],
      permissions: ['projects:read', 'issues:read'],
      bound_project_id: w.projectId,
    });
    expect(tokens[0]?.revoked_at).not.toBeNull();
    await credential.revoke();
  });
});

describe('what a script may not read', () => {
  it('refuses a write and another project by name, and the fence answers another project’s issue', async () => {
    const script = `
const out = [];
const attempt = async (label, read) => {
  try { await read(); out.push({ label, ok: true }); }
  catch (e) { out.push({ label, code: e.code ?? null, status: e.status ?? null, message: e.message }); }
};
await attempt('post', () => ctx.forge.post(\`/api/projects/\${ctx.projectId}/requirements\`));
await attempt('get-as-post', () => ctx.forge.get(\`/api/projects/\${ctx.projectId}/requirements\`, { method: 'POST' }));
await attempt('other-project', () => ctx.forge.get('/api/projects/${other.id}/requirements'));
await attempt('other-issue', () => ctx.forge.get('/api/issues/${otherIssue}'));
ctx.log(JSON.stringify(out));
return { frames: [] };`;
    const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/executions`, {
      language: 'javascript',
      script,
      inputs: [],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = JSON.parse(String((res.body.logs as Body).stdout)) as Body[];
    const by = Object.fromEntries(out.map((o) => [o.label, o]));
    const own = `/api/projects/${w.projectId}/requirements`;
    expect(by.post).toMatchObject({ code: 'SCRIPT_READ_REFUSED', status: null });
    expect(String(by.post?.message)).toContain(`POST ${own} is refused`);
    expect(by['get-as-post']).toMatchObject({ code: 'SCRIPT_READ_REFUSED' });
    expect(by['other-project']).toMatchObject({ code: 'SCRIPT_READ_REFUSED', status: null });
    expect(String(by['other-project']?.message)).toContain(
      `GET /api/projects/${other.id}/requirements is refused`,
    );
    // the asker owns the other project too: only the read token's project fence keeps it out
    expect(by['other-issue']?.code).toBeNull();
    expect([403, 404]).toContain(by['other-issue']?.status);

    expect(res.body.reads).toEqual([
      { method: 'POST', path: own, status: null, refused: 'SCRIPT_READ_REFUSED' },
      { method: 'POST', path: own, status: null, refused: 'SCRIPT_READ_REFUSED' },
      {
        method: 'GET',
        path: `/api/projects/${other.id}/requirements`,
        status: null,
        refused: 'SCRIPT_READ_REFUSED',
      },
      { method: 'GET', path: `/api/issues/${otherIssue}`, status: by['other-issue']?.status },
    ]);
  });

  it('answers 403 to a GET the asker’s own token does not cover', async () => {
    const narrow = (
      await mintPat({
        permissions: ['projects:read', 'projects:write', 'assistant.exec'],
        userId: w.userId,
        name: 'no issue reads',
        projectIds: [w.projectId],
      })
    ).plaintext;
    const script = `
const requirements = await ctx.forge.get(\`/api/projects/\${ctx.projectId}/requirements\`);
let issues;
try { await ctx.forge.get('/api/issues/${ownIssue}'); issues = 'read'; }
catch (e) { issues = e.status + ' ' + e.message; }
ctx.log(requirements.requirements.length, issues);
return { frames: [] };`;
    const res = await api(narrow, 'POST', `/api/projects/${w.projectId}/executions`, {
      language: 'javascript',
      script,
      inputs: [],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stdout = String((res.body.logs as Body).stdout);
    expect(stdout).toContain(`2 403 GET /api/issues/${ownIssue} answered 403`);
    expect((res.body.reads as Body[]).map((r) => r.status)).toEqual([200, 403]);
  });
});

describe('a computation that hits a cap', () => {
  it.each([
    ['an endless loop', 'for (;;) {}', { wallMs: 1_500 }, 'wallMs', '(wallMs)'],
    [
      'a memory blow-up',
      'const a = []; for (;;) a.push(new Array(1e5).fill(1));',
      { memoryMb: 32 },
      'memoryMb',
      '(memoryMb)',
    ],
  ])('stops %s at its cap, and the cap names itself', async (_, script, limits, stopped, named) => {
    const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/executions`, {
      language: 'javascript',
      script,
      inputs: [],
      limits,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.stopped).toBe(stopped);
    expect(String((res.body.error as Body).message)).toContain(named);
    expect(res.body.exit).toBe(1);
  });
});

describe('a schedule script', () => {
  const fireOf = async (scheduleId: string) => {
    const [fire] = await rows(sql`
      SELECT status, output, error, run_as, reads FROM schedule_runs
      WHERE schedule_id = ${scheduleId} ORDER BY created_at DESC LIMIT 1
    `);
    return fire as Row;
  };
  const schedule = async (script: string, answered = 202) => {
    const made = await api(w.token, 'POST', '/api/schedules', {
      projectId: w.projectId,
      name: `script ${randomUUID().slice(0, 8)}`,
      cron: '0 3 * * *',
      kind: 'script',
      script,
      enabled: false,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.id);
    const ran = await api(w.token, 'POST', `/api/schedules/${id}/run`);
    // a script fire that fails answers that nothing was started, naming its fire
    expect(ran.status, JSON.stringify(ran.body)).toBe(answered);
    return id;
  };
  const notices = (title: string) =>
    rows(sql`
      SELECT project_id, body FROM notifications WHERE type = 'schedule_report' AND title = ${title}
    `);

  it('keeps ctx.log and ctx.notify as they were, and reads nothing it did not ask for', async () => {
    const before = (await scriptTokens(w.userId)).length;
    const id = await schedule(
      `ctx.log('nightly', ctx.params === null ? 'none' : 'params'); ctx.notify({ title: 'Legacy notice', body: 'still sent' });`,
    );
    const fire = await fireOf(id);
    expect(fire).toMatchObject({
      status: 'success',
      output: 'nightly params',
      reads: [],
      run_as: w.userId,
    });
    expect(await notices('Legacy notice')).toEqual([
      { project_id: w.projectId, body: 'still sent' },
    ]);
    // a script that never reads mints no token
    expect((await scriptTokens(w.userId)).length).toBe(before);
  });

  it('reads its project by GET as whoever ran it, notifies, and records the read', async () => {
    const id = await schedule(`
const { requirements } = await ctx.forge.get(\`/api/projects/\${ctx.projectId}/requirements\`);
ctx.notify({ title: 'Requirement count', body: String(requirements.length) });
ctx.log('counted');`);
    const fire = await fireOf(id);
    expect(fire, JSON.stringify(fire)).toMatchObject({
      status: 'success',
      output: 'counted',
      run_as: w.userId,
      reads: [{ method: 'GET', path: `/api/projects/${w.projectId}/requirements`, status: 200 }],
    });
    expect(await notices('Requirement count')).toEqual([{ project_id: w.projectId, body: '2' }]);
    const tokens = await scriptTokens(w.userId);
    expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);
  });

  it('fails a write by name, and the fire records the refusal', async () => {
    const id = await schedule(
      `await ctx.forge.post(\`/api/projects/\${ctx.projectId}/requirements\`);`,
      422,
    );
    const fire = await fireOf(id);
    expect(fire.status).toBe('failed');
    expect(String(fire.error)).toContain('SCRIPT_READ_REFUSED');
    expect(String(fire.error)).toContain('POST');
    expect(fire.reads).toEqual([
      {
        method: 'POST',
        path: `/api/projects/${w.projectId}/requirements`,
        status: null,
        refused: 'SCRIPT_READ_REFUSED',
      },
    ]);
  });
});
