/**
 * A chat turn reads and writes only what the person asking may, and never another project's data
 * (REQ-30 BC-10; workflow design chat-turn r2, steps `perms` and `denied`). Both modes are planted:
 * the Assistant's turn token, which its in-process tools and its `forge` CLI carry, and an Agent
 * session's token, which its shell sends to REST and /mcp. The person asking belongs to the other
 * project, so the project fence, not the person's role, is what each refusal reads.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChannelWorld, changeNotice, ok, openChannelWorld } from '../helpers/channel-world.js';
import { closeWorld, type Doc, type Reply, requester } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;
type TurnFacts = import('../../src/lib/tool.js').ChatTurnFacts;
type Mode = 'assistant' | 'agent';

const MODES: readonly Mode[] = ['assistant', 'agent'];
const OTHER = 'Payroll export for the other project';

let w: ChannelWorld;
let say: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
let callMcp: (who: string, name: string, args: Record<string, unknown>) => Promise<Doc>;
let tools: (who: string, turn?: Partial<TurnFacts>) => Toolset;
let text: (r: Awaited<ReturnType<Toolset['execute']>>) => string;

const ids = {
  home: '',
  other: '',
  otherIssue: '',
  otherRun: '',
  homeIssue: '',
  asker: '',
  viewer: '',
};

const count = async (table: string, projectId: string): Promise<number> =>
  Number(
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE project_id = ${projectId}`,
      )
    )[0]?.n,
  );

beforeAll(async () => {
  w = await openChannelWorld();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor } = await import('../../src/credentials/pat-format.js');
  const { AGENT_TURN_MENU, CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { createChatSessionRow, mintSessionCredential, resolveSessionAuthority } = await import(
    '../../src/agent-sessions/index.js'
  );
  const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { toolResultText } = await import('../../src/assistant/tools/mcp-adapter.js');
  text = toolResultText;

  // the person asking owns both projects: only the turn's fence keeps the other one out
  ids.asker = (await createTestUser({ verified: true })).id;
  const home = await createTestProject(ids.asker);
  const other = await createTestProject(ids.asker, { orgId: home.orgId });
  ids.home = home.id;
  ids.other = other.id;
  ids.viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(ids.home, ids.viewer, 'viewer');
  const device = await createTestDevice(ids.asker);

  const at = new Date();
  ids.otherIssue = (
    await createTestIssue(ids.other, ids.asker, 1, { status: 'open', createdAt: at })
  ).id;
  await createTestRequirement(ids.other, 1, OTHER);
  await createTestFeedback(ids.other, ids.asker, 1);
  await rows(sql`UPDATE issues SET title = ${OTHER} WHERE id = ${ids.otherIssue}`);
  await rows(sql`UPDATE feedback SET title = ${OTHER} WHERE project_id = ${ids.other}`);
  ids.otherRun = await createTestRunSession(ids.other, device, at, null);
  ids.homeIssue = (
    await createTestIssue(ids.home, ids.asker, 1, { status: 'open', createdAt: at })
  ).id;
  await createTestRequirement(ids.home, 7, 'Home requirement');

  const minted: Record<string, Awaited<ReturnType<typeof mintTurnCredential>>> = {};
  const tokens: Record<string, string> = {
    ...w.tokens,
    person: await signUserToken(ids.asker),
  };
  const credentialsFor = async (key: string, userId: string, projectId: string) => {
    const resolved = await resolveTurnAuthority({ userId, projectId, viaTokenId: null });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    minted[key] = await mintTurnCredential({
      authority: resolved.authority,
      menu: CHAT_TURN_MENU,
      ttlMs: 10 * 60_000,
    });
    tokens[`${key}:assistant`] = minted[key].token;
    // the box is held by an account that may write, so a write refused below is the asker's role
    const holderId = projectId === ids.home ? ids.asker : userId;
    const holder = await createTestDevice(holderId);
    await mintPat({
      userId: holderId,
      name: deviceTokenNameFor(holder),
      permissions: ['*'],
      deviceId: holder,
    });
    const session = await createChatSessionRow({
      projectId,
      userId,
      title: 'Chat: fence',
      runKind: 'system',
      metadata: { conversationAgent: { conversationId: randomUUID() } },
    });
    const authority = await resolveSessionAuthority({
      asker: { userId, viaTokenId: null },
      projectId,
      deviceId: holder,
    });
    if (!authority.ok) throw new Error(authority.refusal.message);
    expect(authority.value.menu).toEqual(AGENT_TURN_MENU);
    tokens[`${key}:agent`] = await mintSessionCredential({
      sessionId: session.id,
      deviceId: holder,
      value: authority.value,
    });
  };
  await credentialsFor('asker', ids.asker, ids.home);
  await credentialsFor('viewer', ids.viewer, ids.home);
  // the channel world's store side: in the ecosystem, and a party to nothing forge and plugin say
  await credentialsFor('store', w.user.store, w.project.store);
  // a person the ecosystem-scope chat widens for: a member of store and a viewer of plugin
  const bridge = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.project.store, bridge, 'member');
  await addProjectMember(w.project.plugin, bridge, 'viewer');
  await credentialsFor('bridge', bridge, w.project.store);

  say = requester(w.app, tokens);
  tools = (who, turn) => {
    const credential = minted[who];
    if (!credential) throw new Error(`no turn credential for ${who}`);
    return buildProjectToolset(
      buildChatToolContext({
        credential,
        projectSlug: 'fence',
        turn: {
          conversationId: randomUUID(),
          speakerUserId: credential.principal.userId,
          handleUserId: null,
          ...turn,
        },
      }),
    );
  };
  callMcp = async (who, name, args) => {
    const res = await w.app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens[who]}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Doc;
  };

  const forgeChannel = `/api/projects/${w.project.forge}/channel`;
  const made = ok(await say('masterForge', 'POST', `${forgeChannel}/drafts`, changeNotice(w)));
  ok(await say('masterForge', 'POST', `${forgeChannel}/documents/${made.id}/submit`));

  // an executor is enabled, so forge_compute reaches the asker's permission; it must never be called
  const { registerExecutor, unregisterExecutorForTest } = await import(
    '../../src/reports/index.js'
  );
  const FENCE_EXECUTOR_ID = 'fence-sandbox';
  registerExecutor({
    id: FENCE_EXECUTOR_ID,
    mode: 'invoked',
    isolation: 'a test double that refuses every call',
    network: 'none',
    dataLeavesTo: 'forge',
    zdrEligible: true,
    availableFor: () => true,
    execute: async () => {
      throw new Error("a viewer's computation reached a sandbox");
    },
  });
  dropExecutor = () => unregisterExecutorForTest(FENCE_EXECUTOR_ID);
}, 180_000);

let dropExecutor = () => {};

afterAll(async () => {
  dropExecutor();
  await closeWorld();
});

/** Refused, and nothing of the other project in what came back. */
function refusedBlind(r: Reply): void {
  expect([403, 404], JSON.stringify(r.json)).toContain(r.status);
  expect(JSON.stringify(r.json)).not.toContain(OTHER);
}

const otherReads = (): [string, string][] => [
  ['its issue by id', `/api/issues/${ids.otherIssue}`],
  ['its issue by key', `/api/issues/ISS-1?projectId=${ids.other}`],
  ['its requirement', `/api/projects/${ids.other}/requirements/REQ-1`],
  ['its feedback', `/api/projects/${ids.other}/feedback/FB-1`],
];

describe("a turn's token never reads another project the person asking belongs to", () => {
  it('the person reads each of them signed in, so the person may', async () => {
    for (const [what, path] of otherReads()) {
      const r = await say('person', 'GET', path);
      expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(200);
      expect(JSON.stringify(r.json), what).toContain(OTHER);
    }
  });

  for (const mode of MODES) {
    it(`the ${mode} token is refused each of them, and reads its own project`, async () => {
      for (const [, path] of otherReads()) refusedBlind(await say(`asker:${mode}`, 'GET', path));
      ok(await say(`asker:${mode}`, 'GET', `/api/issues/${ids.homeIssue}`));
    });
  }

  it("the Assistant's own tools answer the turn's project whatever project they are named", async () => {
    const set = tools('asker');
    const one = await set.execute(
      'forge_requirement',
      JSON.stringify({ projectId: ids.other, requirement: 'REQ-1' }),
    );
    expect(text(one)).not.toContain(OTHER);
    const listed = await set.execute(
      'forge_requirements',
      JSON.stringify({ projectId: ids.other }),
    );
    expect(listed.isError, text(listed)).toBeFalsy();
    expect(text(listed)).toContain('Home requirement');
    expect(text(listed)).not.toContain(OTHER);
  });

  it('a pipeline run of the other project, named by its own id, is not found from a turn', async () => {
    const r = await tools('asker').execute(
      'forge_project_pipeline_runs',
      JSON.stringify({ action: 'get', runId: ids.otherRun }),
    );
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toContain('PIPELINE_RUN_NOT_FOUND');
    expect(text(r)).not.toContain(ids.other);
    refusedBlind(await say('asker:agent', 'GET', `/api/pipeline-runs/${ids.otherRun}`));
    ok(await say('person', 'GET', `/api/pipeline-runs/${ids.otherRun}`));
  });
});

/** Every tool the Assistant is offered, each either a write the test plants or why it is not one. */
const NOT_A_PROJECT_WRITE: Record<string, string> = {
  forge: 'its writes are the REST calls its token makes, planted below over REST',
  forge_knowledge: 'chat offers only list, get and search',
  forge_memory: 'chat offers only search',
  forge_preferences: "the person's own account settings, which every role holds for itself",
  forge_project_pipeline_runs:
    'pause, resume and cancel need pipeline:write, which no chat token holds',
  forge_project_status: 'a read',
  forge_requirements: 'a read',
  forge_requirement: 'a read',
  forge_releases: 'a read',
  forge_release: 'a read',
  forge_decisions: 'a read',
  forge_metrics_project_step_durations: 'a read',
  forge_metrics_project_timeseries: 'a read',
  forge_report: "a run of a query, kept as the asker's own read",
  forge_show: 'draws a block of a run this turn made into the room',
  forge_template: "a template run, kept as the asker's own read",
};

/** Each write tool, a call a member could make, and the permission a viewer is refused it by. */
const viewerWrites = (): [string, Record<string, unknown>, string][] => [
  ['forge_feedback', { kind: 'bug', title: 'Viewer feedback', screen: '/board' }, 'project.write'],
  [
    'forge_requirement_draft',
    { title: 'Viewer requirement', reason: 'A viewer asked.', criteria: [{ body: 'It holds.' }] },
    'project.write',
  ],
  [
    'forge_requirement_revise',
    {
      requirement: 'REQ-7',
      baseRevision: null,
      reason: 'A viewer asked.',
      criteria: [{ body: 'It holds.' }],
    },
    'project.write',
  ],
  ['forge_memory_note', { text: 'A viewer remembers this.' }, 'project.write'],
  ['forge_template_save', { templateId: 'status', runIds: [randomUUID()] }, 'project.write'],
  ['forge_compute', { language: 'python', script: 'print(1)', inputs: [] }, 'assistant.exec'],
  [
    'forge_channel',
    {
      action: 'draft',
      ecosystem: randomUUID(),
      type: 'rfi',
      to: [randomUUID()],
      subject: 'x',
      body: {},
    },
    'project.write',
  ],
];

describe("every write a turn makes is held to the asker's own role", () => {
  const restWrites = (): [string, string, string, unknown][] => [
    [
      'feedback',
      'POST',
      `/api/projects/${ids.home}/feedback`,
      { kind: 'bug', title: 'Viewer feedback', screen: '/board' },
    ],
    [
      'a requirement',
      'POST',
      `/api/projects/${ids.home}/requirements`,
      { title: 'Viewer requirement', reason: 'A viewer asked.', criteria: [{ body: 'It holds.' }] },
    ],
    ['a comment', 'POST', `/api/issues/${ids.homeIssue}/comments`, { body: 'A viewer comments.' }],
    ['an issue field', 'PATCH', `/api/issues/${ids.homeIssue}`, { priority: 'high' }],
  ];

  for (const mode of MODES) {
    it(`refuses each REST write of a viewer's ${mode} token, by the permission it lacks`, async () => {
      const before = await Promise.all(
        ['feedback', 'requirements', 'knowledge_entries'].map((t) => count(t, ids.home)),
      );
      for (const [what, method, path, body] of restWrites()) {
        const r = await say(`viewer:${mode}`, method, path, body);
        expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(403);
        expect(JSON.stringify(r.json), what).toContain('project.write');
      }
      const after = await Promise.all(
        ['feedback', 'requirements', 'knowledge_entries'].map((t) => count(t, ids.home)),
      );
      expect(after).toEqual(before);
      const issue = ok(await say('person', 'GET', `/api/issues/${ids.homeIssue}`));
      expect(issue.priority).toBe('medium');
      expect(issue.comments ?? []).toHaveLength(0);
    });
  }

  // a knowledge entry reaches every prompt, so no card carries it: a chat is refused it by name
  // whatever the asker's role (REQ-30 BC-4, ISS-439 round 3), and nothing is written
  it('refuses a knowledge entry from every chat token, viewer and owner alike', async () => {
    const before = await count('knowledge_entries', ids.home);
    for (const who of MODES.flatMap((mode) => [`viewer:${mode}`, `asker:${mode}`])) {
      const r = await say(who, 'PUT', `/api/projects/${ids.home}/knowledge/viewer-note`, {
        title: 'Viewer note',
        body: 'A viewer writes.',
      });
      expect(r.status, `${who}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(JSON.stringify(r.json), who).toContain('CHAT_WRITE_REFUSED');
    }
    expect(await count('knowledge_entries', ids.home)).toBe(before);
  });

  // an owner's chat write passes the role check and meets the hold that waits for the person to
  // agree (ISS-439, REQ-30 BC-4): not the viewer's permission refusal, so the role is what refused it
  it("lets the same write past the role for an owner's token, to wait for their go-ahead", async () => {
    const before = await count('feedback', ids.home);
    for (const mode of MODES) {
      const r = await say(`asker:${mode}`, 'POST', `/api/projects/${ids.home}/feedback`, {
        kind: 'bug',
        title: `Owner feedback (${mode})`,
        screen: '/board',
      });
      expect(r.status, `${mode}: ${JSON.stringify(r.json)}`).toBe(409);
      expect(JSON.stringify(r.json), mode).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
      expect(JSON.stringify(r.json), mode).not.toContain('project.write');
    }
    expect(await count('feedback', ids.home)).toBe(before);
  });

  it('classifies every tool the Assistant is offered, so a new write cannot join unplanted', () => {
    const offered = tools('viewer').tools.map((t) => t.function.name);
    const planted = viewerWrites().map(([name]) => name);
    const unclassified = offered.filter((n) => !planted.includes(n) && !(n in NOT_A_PROJECT_WRITE));
    expect(
      unclassified,
      'offered tools that are neither a planted write nor named a non-write',
    ).toEqual([]);
    for (const name of planted) expect(offered, name).toContain(name);
  });

  it("refuses each of the Assistant's write tools for a viewer, and writes nothing", async () => {
    const set = tools('viewer');
    const before = await Promise.all(
      ['feedback', 'requirements', 'memories'].map((t) => count(t, ids.home)),
    );
    for (const [name, args, permission] of viewerWrites()) {
      const r = await set.execute(name, JSON.stringify(args));
      expect(r.isError, `${name}: ${text(r)}`).toBe(true);
      expect(text(r), name).toContain(`needs ${permission}`);
    }
    const after = await Promise.all(
      ['feedback', 'requirements', 'memories'].map((t) => count(t, ids.home)),
    );
    expect(after).toEqual(before);
  });

  // a channel document speaks to another project's team, which no card in this room answers for:
  // an Agent session is refused it over /mcp by name, whatever its role (ISS-439 round 3)
  it("refuses a viewer's Agent session the channel write it makes over /mcp", async () => {
    const draft = viewerWrites().find(([name]) => name === 'forge_channel');
    if (!draft) throw new Error('the channel draft is not planted');
    const r = await callMcp('viewer:agent', 'forge_channel', draft[1]);
    expect(r.result?.isError, JSON.stringify(r)).toBe(true);
    expect(JSON.stringify(r)).toContain('CHAT_WRITE_REFUSED');
    expect(JSON.stringify(r)).toContain('channel document');
  });
});

describe('the channel tool, from a chat turn, reads only what the asker may', () => {
  const cn = 'FP-CN-1';

  it('the forge and plugin sides read the notice they exchanged', async () => {
    const forgeRead = ok(
      await say('platform', 'GET', `/api/projects/${w.project.forge}/channel/documents/${cn}`),
    );
    expect(forgeRead.document.number).toBe(cn);
  });

  it('refuses, in process, a notice between two projects the asker is in neither of', async () => {
    const set = tools('store');
    const read = await set.execute('forge_channel', JSON.stringify({ action: 'read', ref: cn }));
    expect(read.isError, text(read)).toBe(true);
    expect(text(read)).toContain('CHANNEL_NOT_A_PARTY');
    const named = await set.execute(
      'forge_channel',
      JSON.stringify({ projectId: w.project.forge, action: 'inbox' }),
    );
    expect(named.isError, text(named)).toBeFalsy();
    expect(text(named)).not.toContain(cn);
    const register = await set.execute('forge_channel', JSON.stringify({ action: 'register' }));
    expect(register.isError, text(register)).toBeFalsy();
    expect(text(register)).not.toContain(cn);
  });

  it('refuses, on /mcp, an Agent session naming a project its token does not reach', async () => {
    const named = await callMcp('store:agent', 'forge_channel', {
      projectId: w.project.forge,
      action: 'read',
      ref: cn,
    });
    expect(named.result?.isError, JSON.stringify(named)).toBe(true);
    expect(JSON.stringify(named)).not.toContain(changeNotice(w).subject);
    const own = await callMcp('store:agent', 'forge_channel', { action: 'read', ref: cn });
    expect(JSON.stringify(own)).toContain('CHANNEL_NOT_A_PARTY');
  });

  it("widens an ecosystem-scope chat only to the asker's own projects", async () => {
    const scoped = { ecosystemId: w.eco };
    const outsider = await tools('store', scoped).execute(
      'forge_channel',
      JSON.stringify({ action: 'register' }),
    );
    expect(outsider.isError, text(outsider)).toBeFalsy();
    expect(text(outsider)).not.toContain(cn);
    const read = await tools('store', scoped).execute(
      'forge_channel',
      JSON.stringify({ action: 'read', ref: cn }),
    );
    expect(text(read)).toContain('CHANNEL_NOT_A_PARTY');
    const bridged = await tools('bridge', scoped).execute(
      'forge_channel',
      JSON.stringify({ action: 'read', ref: cn }),
    );
    expect(bridged.isError, text(bridged)).toBeFalsy();
    expect(text(bridged)).toContain(cn);
  });
});
