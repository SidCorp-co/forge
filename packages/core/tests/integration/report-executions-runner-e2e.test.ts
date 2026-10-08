import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReportRunSchema } from '@forge/contracts/report-queries';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { deviceRoom, roomManager } from '../../src/lib/rooms.js';
import { registerExecutor, unregisterExecutorForTest } from '../../src/reports/index.js';
import { createRunnerSandboxExecutor, RUNNER_SANDBOX_ID } from '../../src/runners/index.js';
import { attachWs, closeWs } from '../../src/ws/server.js';
import { api, type Body } from '../helpers/api.js';
import { createTestDevice } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// REQ-32 BC-14: a question no report covers is computed in a sandbox on the team's own runner. A
// project with Computation on, and nothing more, hands its script and the asker's run frames to a
// box bound to it over the box's own socket; the box answers on its device route and the frames
// come back as a computed block. Where no box can run it (none paired, none connected, one that
// cannot confine on Linux, one too old to say) the computation is refused naming why, and no
// frame reaches any box.

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const FRAMES = {
  frames: [
    {
      fields: [{ name: 'share', type: 'number', label: 'Share', unit: '%' }],
      rows: [{ share: 43.75 }],
    },
  ],
};
const script = 'import json\nprint(len(json.load(open("inputs.json"))))';
const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const detail = (res: { body: Body }) => String(res.body.detail);

const SANDBOX = {
  computeSandbox: true,
  computeSandboxLanguages: ['bash', 'python'],
};

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** A paired box: its socket on the device room, and what it answers each `compute.run`. */
interface Box {
  deviceId: string;
  token: string;
  frames: Frame[];
  answer: ((data: Record<string, unknown>) => Body | null) | null;
  answered: { status: number; body: Body }[];
  close(): void;
}

let server: Server;
let url = '';
let w: World;

const runQuery = async (projectId = w.projectId, token = w.token) => {
  const res = await api(
    token,
    'POST',
    `/api/projects/${projectId}/report-queries/progress-by-requirement/runs`,
    {},
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ReportRunSchema.parse(res.body);
};
const compute = (body: Body, token = w.token, projectId = w.projectId) =>
  api(token, 'POST', `/api/projects/${projectId}/executions`, body);
const kept = async (projectId: string) =>
  Number(
    (
      await db.execute<{ n: string }>(
        sql`SELECT count(*)::int AS n FROM report_executions WHERE project_id = ${projectId}`,
      )
    )[0]?.n,
  );

async function boxToken(ownerId: string, deviceId: string): Promise<string> {
  return (await mintPat({ permissions: ['*'], userId: ownerId, name: `box-${deviceId}`, deviceId }))
    .plaintext;
}

/** What the box says about itself, as its heartbeat carries it. */
async function beat(token: string, capabilities: Record<string, unknown>): Promise<void> {
  const res = await api(token, 'POST', '/api/devices/heartbeat', {
    agentVersion: '9.9.9',
    capabilities,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Opens the box's socket as forge-runner does: its token in the header, then its device room. */
async function connect(deviceId: string, token: string): Promise<Box> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const box: Box = {
    deviceId,
    token,
    frames: [],
    answer: null,
    answered: [],
    close: () => ws.close(),
  };
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Frame;
    box.frames.push(frame);
    if (frame.event !== 'compute.run' || !box.answer) return;
    const body = box.answer(frame.data);
    if (body === null) return;
    void api(token, 'POST', `/api/devices/me/compute-runs/${String(frame.data.requestId)}`, {
      projectId: frame.data.projectId,
      ...body,
    }).then((res) => box.answered.push({ status: res.status, body: res.body }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => resolve());
  });
  ws.send(JSON.stringify({ type: 'subscribe', room: deviceRoom(deviceId) }));
  for (let i = 0; i < 100 && roomManager.roomSize(deviceRoom(deviceId)) === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(roomManager.roomSize(deviceRoom(deviceId)), 'the box socket joined its room').toBe(1);
  return box;
}

const computeRuns = (box: Box) => box.frames.filter((f) => f.event === 'compute.run');

beforeAll(async () => {
  server = createServer();
  attachWs(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  w = await world();
  // Computation on, and nothing else: no third party is admitted, so only a sandbox whose data
  // stays with the team may take it
  await seedProjectDocument(w.projectId, w.userId, {
    environments: {},
    extra: { compute: { enabled: true } },
  });
}, 120_000);

afterAll(async () => {
  await closeWs();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a computation on the team runner', () => {
  let box: Box;

  beforeAll(async () => {
    const token = await boxToken(w.userId, w.deviceId);
    await beat(token, SANDBOX);
    box = await connect(w.deviceId, token);
  });
  afterAll(() => box.close());
  beforeEach(() => {
    box.frames.length = 0;
    box.answered.length = 0;
    box.answer = () => ({
      exit: 0,
      durationMs: 41,
      output: { file: 'frames.json', text: JSON.stringify(FRAMES) },
      stdout: `1\ntoken=${SECRET}\n`,
      stderr: '',
    });
  });

  it('runs on the paired box and answers its frames as a computed block', async () => {
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapter).toBe('runner-sandbox');
    expect(res.body.computed).toBe(true);
    expect(res.body.exit).toBe(0);
    expect(res.body.frames).toEqual(FRAMES.frames);
    expect(JSON.stringify(res.body.logs)).not.toContain('ghp_');

    const [sent] = computeRuns(box);
    expect(sent?.data).toMatchObject({
      projectId: w.projectId,
      language: 'python',
      script,
      inputs: [run.frame],
      limits: { wallMs: 30_000, cpu: 1, memoryMb: 512, outputBytes: 256_000 },
    });
    expect(box.answered).toEqual([{ status: 200, body: { settled: true } }]);

    const executionId = String(res.body.executionId);
    const read = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/executions/${executionId}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ adapter: 'runner-sandbox', script, exit: 0 });
  });

  it('answers a frames.csv table as a frame', async () => {
    box.answer = () => ({
      exit: 0,
      durationMs: 9,
      output: { file: 'frames.csv', text: 'team,done\nweb,3\ncore,5\n' },
      stdout: '',
      stderr: '',
    });
    const run = await runQuery();
    const res = await compute({ language: 'bash', script: 'echo hi', inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.frames).toEqual([
      {
        fields: [
          { name: 'team', type: 'string', label: 'team' },
          { name: 'done', type: 'number', label: 'done' },
        ],
        rows: [
          { team: 'web', done: 3 },
          { team: 'core', done: 5 },
        ],
      },
    ]);
  });

  it('shows a script that tried the network failing inside the sandbox, with no frames', async () => {
    box.answer = () => ({
      exit: 1,
      durationMs: 30,
      stdout: '',
      stderr:
        'urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>\n',
    });
    const run = await runQuery();
    const res = await compute({
      language: 'python',
      script: 'import urllib.request\nurllib.request.urlopen("https://example.com")',
      inputs: [run.runId],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.exit).toBe(1);
    expect(res.body.frames).toEqual([]);
    expect(String((res.body.logs as Body).stderr)).toContain(
      'Temporary failure in name resolution',
    );
  });

  it('names the stop when the box stopped the script at a limit', async () => {
    box.answer = () => ({ exit: 137, durationMs: 1000, stopped: 'wallMs', stdout: '', stderr: '' });
    const run = await runQuery();
    const res = await compute({
      language: 'bash',
      script: 'sleep 5',
      inputs: [run.runId],
      limits: { wallMs: 1000 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ exit: 137, stopped: 'wallMs', frames: [] });
  });

  it('keeps an output that is not frames as the error that says so, never as frames', async () => {
    box.answer = () => ({
      exit: 0,
      durationMs: 5,
      output: { file: 'frames.json', text: '{"rows": []}' },
      stdout: '',
      stderr: '',
    });
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.frames).toEqual([]);
    expect(res.body.error).toEqual({
      name: 'FramesUnreadable',
      message: 'frames.json holds no "frames" array',
    });
  });

  it('refuses a computation the box could not start, naming its reason, and keeps nothing', async () => {
    box.answer = () => ({ error: 'python3 is not installed on this box' });
    const before = await kept(w.projectId);
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect([res.status, code(res)]).toEqual([503, 'EXECUTOR_FAILED']);
    expect(detail(res)).toContain('python3 is not installed on this box');
    expect(await kept(w.projectId)).toBe(before);
  });

  it('refuses a computation the box never answered, naming the wait, and keeps nothing', async () => {
    unregisterExecutorForTest(RUNNER_SANDBOX_ID);
    registerExecutor(createRunnerSandboxExecutor({ overheadMs: 100 }));
    box.answer = () => null;
    try {
      const before = await kept(w.projectId);
      const run = await runQuery();
      const res = await compute({
        language: 'bash',
        script: 'true',
        inputs: [run.runId],
        limits: { wallMs: 200 },
      });
      expect([res.status, code(res)]).toEqual([503, 'EXECUTOR_FAILED']);
      expect(detail(res)).toContain('did not answer within');
      expect(computeRuns(box)).toHaveLength(1);
      expect(await kept(w.projectId)).toBe(before);
    } finally {
      unregisterExecutorForTest(RUNNER_SANDBOX_ID);
      registerExecutor(createRunnerSandboxExecutor());
    }
  });

  it('refuses an answer for a run that was never asked of this box', async () => {
    const res = await api(
      box.token,
      'POST',
      '/api/devices/me/compute-runs/00000000-0000-4000-8000-000000000000',
      { projectId: w.projectId, exit: 0, durationMs: 1, stdout: '', stderr: '' },
    );
    expect([res.status, code(res)]).toEqual([404, 'COMPUTE_RUN_NOT_ASKED']);
  });
});

describe('no runner that can run it', () => {
  const refused = async (projectWorld: World) => {
    const run = await runQuery(projectWorld.projectId, projectWorld.token);
    const res = await compute(
      { language: 'python', script, inputs: [run.runId] },
      projectWorld.token,
      projectWorld.projectId,
    );
    expect([res.status, code(res)], JSON.stringify(res.body)).toEqual([
      503,
      'EXECUTOR_UNAVAILABLE',
    ]);
    expect(await kept(projectWorld.projectId)).toBe(0);
    return detail(res);
  };
  const computeOn = async () => {
    const other = await world();
    await seedProjectDocument(other.projectId, other.userId, {
      environments: {},
      extra: { compute: { enabled: true } },
    });
    return other;
  };

  it('refuses where no runner is paired with the project', async () => {
    const other = await computeOn();
    await db.execute(sql`DELETE FROM runners WHERE project_id = ${other.projectId}`);
    expect(await refused(other)).toContain('no runner is paired with this project');
  });

  it('refuses where the paired box is not connected, and sends nothing', async () => {
    const other = await computeOn();
    await beat(await boxToken(other.userId, other.deviceId), SANDBOX);
    expect(await refused(other)).toContain('is not connected');
  });

  it('refuses where the box cannot confine a script, naming why, and sends nothing', async () => {
    const other = await computeOn();
    const token = await boxToken(other.userId, other.deviceId);
    await beat(token, {
      computeSandbox: false,
      computeSandboxUnavailable:
        'bubblewrap (`bwrap`) is not installed on this box; install it (`apt install bubblewrap`)',
    });
    const box = await connect(other.deviceId, token);
    try {
      expect(await refused(other)).toContain('bubblewrap (`bwrap`) is not installed on this box');
      expect(computeRuns(box)).toEqual([]);
    } finally {
      box.close();
    }
  });

  it('refuses where the box runner is too old to run one, and sends nothing', async () => {
    const other = await computeOn();
    const token = await boxToken(other.userId, other.deviceId);
    await beat(token, { confinedChat: true });
    const box = await connect(other.deviceId, token);
    try {
      expect(await refused(other)).toContain('forge-runner update');
      expect(computeRuns(box)).toEqual([]);
    } finally {
      box.close();
    }
  });

  it('refuses a language the box has no interpreter for, and sends nothing', async () => {
    const other = await computeOn();
    const token = await boxToken(other.userId, other.deviceId);
    await beat(token, { computeSandbox: true, computeSandboxLanguages: ['bash'] });
    const box = await connect(other.deviceId, token);
    try {
      expect(await refused(other)).toContain('python');
      expect(computeRuns(box)).toEqual([]);
    } finally {
      box.close();
    }
  });

  it('names every bound box once, and picks one that can run it over one that cannot', async () => {
    const other = await computeOn();
    const second = await createTestDevice(other.userId);
    await db.execute(sql`
      INSERT INTO runners (project_id, type, device_id, name, status, last_seen_at, repo_path)
      VALUES (${other.projectId}, 'claude-code', ${second}, 'box-2', 'online', now(), '/srv/two')
    `);
    const oldToken = await boxToken(other.userId, other.deviceId);
    await beat(oldToken, {});
    const old = await connect(other.deviceId, oldToken);
    const newToken = await boxToken(other.userId, second);
    await beat(newToken, SANDBOX);
    const ready = await connect(second, newToken);
    ready.answer = () => ({
      exit: 0,
      durationMs: 3,
      output: { file: 'frames.json', text: JSON.stringify(FRAMES) },
      stdout: '',
      stderr: '',
    });
    try {
      const run = await runQuery(other.projectId, other.token);
      const res = await compute(
        { language: 'python', script, inputs: [run.runId] },
        other.token,
        other.projectId,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(computeRuns(old)).toEqual([]);
      expect(computeRuns(ready)).toHaveLength(1);
    } finally {
      old.close();
      ready.close();
    }
  });
});
