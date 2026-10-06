import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000003';
const ISSUE_ID = '00000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-10-06T10:00:00Z');

const state = vi.hoisted(() => ({
  run: { status: 'running', kind: 'interactive' } as { status: string; kind: string } | undefined,
  set: [] as Array<Record<string, unknown>>,
  transitions: [] as Array<Record<string, unknown>>,
  frames: [] as Array<{
    deviceId: string;
    envelope: { event: string; data: Record<string, unknown> };
  }>,
  delivered: 1,
  listening: true,
  boundPath: '/bound' as string | null,
  preambleFails: false,
  transcript: [] as Array<Record<string, unknown>>,
  written: [] as Array<{ id: string; messages: unknown[] }>,
  seeded: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
}));

vi.mock('../db/client.js', () => {
  const tx = {
    execute: async () => (state.run ? [state.run] : []),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.set.push(v);
        return {
          where: () => ({
            returning: async () => [{ ...current(), ...v }],
          }),
        };
      },
    }),
  };
  return { db: { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } };
});

const current = vi.hoisted(() => () => base);
vi.mock('../lib/device-pool.js', () => ({
  resolveSessionRepoPathForDevice: vi.fn(async () => {
    state.calls.push('resolveRepoPath');
    return state.boundPath;
  }),
  findAvailableDeviceForProject: vi.fn(),
  findChatCapableDeviceForProject: vi.fn(),
}));
vi.mock('../pipeline/index.js', () => ({
  assertRunAcceptsWork: vi.fn(async () => {}),
  insertOneShotRun: vi.fn(async () => ({ id: 'run-next' })),
  openOneShotRun: vi.fn(async () => ({ id: 'run-1' })),
}));
const logError = vi.hoisted(() => vi.fn());
vi.mock('../lib/logger.js', () => ({ logger: { error: logError, warn: vi.fn(), info: vi.fn() } }));
vi.mock('./attachment-service.js', () => ({
  listSessionAttachmentsByIds: vi.fn(async (_s: string, ids: string[]) =>
    ids.map((id) => ({ id, name: `${id}.png` })),
  ),
}));
const applyAutoTitleAsync = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./auto-title.js', () => ({ applyAutoTitleAsync }));
const broadcastSession = vi.hoisted(() => vi.fn());
const broadcastTurnAppended = vi.hoisted(() => vi.fn());
vi.mock('./broadcast.js', () => ({ broadcastSession, broadcastTurnAppended }));
vi.mock('./ports.js', () => ({
  agentSessionsPorts: () => ({
    boxIsListening: () => {
      state.calls.push('boxIsListening');
      return state.listening;
    },
    buildChatPreamble: async () => {
      if (state.preambleFails) throw new Error('preamble down');
      return 'PREAMBLE\n';
    },
    readContentLanguage: async () => ({
      contentLanguage: 'vi',
      keepTermsInEnglish: [],
      source: 'document',
      revision: 7,
    }),
    resolveSessionMcpServers: async () => ({ mcpServers: { forge: { url: 'x' } } }),
    sendToBoxNow: (deviceId: string, envelope: never) => {
      state.frames.push({ deviceId, envelope });
      return state.delivered;
    },
    toolReference: () => 'TOOLS',
  }),
}));
vi.mock('./session-events.js', () => ({
  seedTurn: vi.fn(async (_tx: unknown, _id: string, a: Record<string, unknown>) => {
    state.seeded.push(a);
    return { lastSeq: 41 };
  }),
}));
vi.mock('./session-transition.js', () => ({
  transitionSessions: vi.fn(async (_exec: unknown, args: Record<string, unknown>) => {
    state.transitions.push(args);
    return { rows: [{ id: SESSION_ID }], refusals: [] };
  }),
}));
vi.mock('./turns-helpers.js', () => ({
  readTranscript: vi.fn(async () => {
    state.calls.push('readTranscript');
    return state.transcript;
  }),
  writeTranscript: vi.fn(async (_tx: unknown, id: string, messages: unknown[]) => {
    state.written.push({ id, messages });
    return { appended: [{ turnIndex: messages.length - 1 }] };
  }),
}));

const { dispatchChatTurn } = await import('./chat-turn.js');
const { insertOneShotRun } = await import('../pipeline/index.js');

let base: Record<string, unknown>;

function sessionOf(over: Record<string, unknown> = {}) {
  base = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    userId: 'u-1',
    deviceId: 'd-1',
    pipelineRunId: 'run-1',
    title: 'Mine',
    status: 'idle',
    repoPath: '/r',
    claudeSessionId: 'claude-old',
    startedAt: new Date(0),
    metadata: { deviceId: 'd-1' },
    ...over,
  };
  return base as never;
}

const project = { id: PROJECT_ID, slug: 'forge' };
const frame = () => state.frames[0]?.envelope;
const refused = (code: string) => ({ refusals: [expect.objectContaining({ code })] });
const metaWritten = () => state.set[0]?.metadata as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  Object.assign(state, {
    run: { status: 'running', kind: 'interactive' },
    delivered: 1,
    listening: true,
    boundPath: '/bound',
    preambleFails: false,
    transcript: [{ type: 'user', content: 'earlier' }],
  });
  for (const k of ['set', 'transitions', 'frames', 'written', 'seeded', 'calls'] as const) {
    state[k].length = 0;
  }
});

describe('dispatchChatTurn: a follow-up on the same box resumes', () => {
  it('writes the patch, moves the session to running, and sends agent:send', async () => {
    const out = await dispatchChatTurn({
      session: sessionOf(),
      project,
      client: { deviceId: 'd-1' },
      message: 'hello',
      actor: { type: 'user', id: 'u-1' } as never,
    });
    expect(state.set).toEqual([
      {
        lastHeartbeatAt: NOW,
        updatedAt: NOW,
        startedAt: new Date(0),
        failureReason: null,
        repoPath: '/r',
        metadata: { deviceId: 'd-1' },
        pipelineRunId: 'run-1',
      },
    ]);
    expect(state.transitions).toEqual([
      expect.objectContaining({
        to: 'running',
        expect: 'idle',
        actor: { type: 'user', id: 'u-1' },
        source: 'chat-turn',
      }),
    ]);
    const userEntry = {
      id: expect.any(String),
      type: 'user',
      content: 'hello',
      timestamp: NOW.getTime(),
    };
    expect(state.written).toEqual([
      { id: SESSION_ID, messages: [{ type: 'user', content: 'earlier' }, userEntry] },
    ]);
    expect(state.seeded).toEqual([
      { priorMessages: [{ type: 'user', content: 'earlier' }], entry: userEntry, at: NOW },
    ]);
    expect(broadcastTurnAppended).toHaveBeenCalledTimes(1);
    expect(state.frames).toEqual([
      {
        deviceId: 'd-1',
        envelope: {
          event: 'agent:send',
          data: {
            sessionId: SESSION_ID,
            eventSeqBase: 41,
            repoPath: '/r',
            projectSlug: 'forge',
            mcpServersOverride: { forge: { url: 'x' } },
            message: 'hello',
            claudeSessionId: 'claude-old',
          },
        },
      },
    ]);
    expect(out.status).toBe('running');
    expect(broadcastSession).toHaveBeenCalledWith(out, 'agent-session.updated');
    expect(applyAutoTitleAsync).not.toHaveBeenCalled();
    expect(state.calls).not.toContain('resolveRepoPath');
  });

  it('a session already running is not moved again, and the client claudeSessionId wins', async () => {
    await dispatchChatTurn({
      session: sessionOf({ status: 'running' }),
      project,
      client: { deviceId: 'd-1' },
      message: 'again',
      claudeSessionId: 'claude-client',
    });
    expect(state.transitions).toEqual([]);
    expect(frame()?.data.claudeSessionId).toBe('claude-client');
  });

  it('prepends the [Context: …] header only when the page changed', async () => {
    const pageContext = { page: 'issue', issueId: ISSUE_ID, issueDisplayId: 'ISS-1' };
    await dispatchChatTurn({
      session: sessionOf({ metadata: { pageContext } }),
      project,
      client: { deviceId: 'd-1' },
      message: 'same page',
      pageContext,
    });
    expect(frame()?.data.message).toBe('same page');
    state.frames.length = 0;
    await dispatchChatTurn({
      session: sessionOf({ metadata: { pageContext: { page: 'board' } } }),
      project,
      client: { deviceId: 'd-1' },
      message: 'moved',
      pageContext,
    });
    expect(frame()?.data.message).toBe('[Context: page=issue ISS-1]\nmoved');
  });
});

describe('dispatchChatTurn: a cold start writes the prompt', () => {
  it('a first turn carries skill, preamble, language and history, and records them', async () => {
    state.transcript = [];
    const out = await dispatchChatTurn({
      session: sessionOf({ title: 'Chat', claudeSessionId: null, startedAt: null, metadata: null }),
      project,
      client: { deviceId: 'd-1' },
      message: '  first\n question ',
      pageContext: { page: 'board' },
      attachmentIds: ['a-1'],
      skillName: 'forge-plan',
      model: 'opus' as never,
      credential: 'tok',
      broadcastEvent: 'agent-session.created',
    });
    expect(state.set[0]).toMatchObject({ startedAt: NOW, title: 'first question' });
    expect(metaWritten()).toEqual({
      deviceId: 'd-1',
      model: 'opus',
      pageContext: { page: 'board' },
      contentLanguage: {
        contentLanguage: 'vi',
        keepTermsInEnglish: [],
        source: 'document',
        context: 'chat',
        revision: 7,
      },
      pendingSkillName: 'forge-plan',
      pendingSkillBaselineCount: 1,
    });
    expect(state.written[0]?.messages).toEqual([
      expect.objectContaining({
        content: '[Context: page=board]\n  first\n question ',
        attachments: [{ id: 'a-1', name: 'a-1.png' }],
      }),
    ]);
    const data = frame()?.data as Record<string, unknown>;
    expect(frame()?.event).toBe('agent:start');
    expect(data).toMatchObject({
      sessionId: SESSION_ID,
      eventSeqBase: 41,
      repoPath: '/r',
      projectSlug: 'forge',
      model: 'opus',
      attachments: [{ id: 'a-1', name: 'a-1.png' }],
      forgeToken: 'tok',
      preBuilt: false,
      systemPrompt: 'TOOLS',
    });
    const prompt = data.prompt as string;
    expect(prompt.startsWith('/forge-plan\nPREAMBLE\n## Content language')).toBe(true);
    expect(prompt.endsWith('---\n\n[Context: page=board]\n  first\n question ')).toBe(true);
    expect(applyAutoTitleAsync).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      userMessage: '  first\n question ',
      fallbackTitle: 'first question',
    });
    expect(broadcastSession).toHaveBeenCalledWith(out, 'agent-session.created');
  });

  it('a migrated turn re-resolves the checkout, drops claudeSessionId and replays history', async () => {
    await dispatchChatTurn({
      session: sessionOf(),
      project,
      client: { deviceId: 'd-2', migrated: true },
      message: 'on the new box',
    });
    expect(state.set[0]).toMatchObject({
      repoPath: '/bound',
      deviceId: 'd-2',
      claudeSessionId: null,
    });
    expect(metaWritten().deviceId).toBe('d-2');
    expect(frame()?.event).toBe('agent:start');
    expect(frame()?.data.repoPath).toBe('/bound');
    expect(frame()?.data.prompt).toContain('This is a cold start');
    expect(frame()?.data.prompt).toContain('User: earlier');
  });

  it('a pre-built prompt reads no language and is sent as given', async () => {
    await dispatchChatTurn({
      session: sessionOf({ claudeSessionId: null }),
      project,
      client: { deviceId: 'd-1' },
      message: 'BUILT',
      preBuilt: true,
      skillName: 'go',
    });
    expect(metaWritten().contentLanguage).toBeUndefined();
    expect(frame()?.data).toMatchObject({ prompt: '/go\nBUILT', preBuilt: true });
  });

  it('a preamble that cannot be built leaves the turn running without it', async () => {
    state.preambleFails = true;
    await dispatchChatTurn({
      session: sessionOf({ claudeSessionId: null }),
      project,
      client: { deviceId: 'd-1' },
      message: 'x',
    });
    expect(String(frame()?.data.prompt).startsWith('## Content language')).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('a closed interactive run gets a fresh one-shot run for the turn', async () => {
    state.run = { status: 'completed', kind: 'interactive' };
    await dispatchChatTurn({
      session: sessionOf(),
      project,
      client: { deviceId: 'd-1' },
      message: 'x',
    });
    expect(insertOneShotRun).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      kind: 'interactive',
      metadata: { followsRun: 'run-1' },
    });
    expect(state.set[0]?.pipelineRunId).toBe('run-next');
  });
});

describe('dispatchChatTurn: refusals write nothing', () => {
  const nothingWritten = () => {
    expect(state.set).toEqual([]);
    expect(state.frames).toEqual([]);
  };

  it('no device is NO_CLAUDE_CLIENT', async () => {
    await expect(
      dispatchChatTurn({ session: sessionOf(), project, client: { deviceId: null }, message: 'x' }),
    ).rejects.toMatchObject(refused('NO_CLAUDE_CLIENT'));
    nothingWritten();
  });

  it('a binding that names no checkout is CHECKOUT_UNBOUND, before the box is asked', async () => {
    state.boundPath = null;
    await expect(
      dispatchChatTurn({
        session: sessionOf({ repoPath: null }),
        project,
        client: { deviceId: 'd-1' },
        message: 'x',
      }),
    ).rejects.toMatchObject(refused('CHECKOUT_UNBOUND'));
    expect(state.calls).toEqual(['resolveRepoPath']);
    nothingWritten();
  });

  it('a box nobody listens on is NO_CLAUDE_CLIENT, before the transcript is read', async () => {
    state.listening = false;
    await expect(
      dispatchChatTurn({
        session: sessionOf(),
        project,
        client: { deviceId: 'd-1' },
        message: 'x',
      }),
    ).rejects.toMatchObject(refused('NO_CLAUDE_CLIENT'));
    expect(state.calls).toEqual(['boxIsListening']);
    nothingWritten();
  });

  it('an invalid skill name is refused', async () => {
    await expect(
      dispatchChatTurn({
        session: sessionOf(),
        project,
        client: { deviceId: 'd-1' },
        message: 'x',
        skillName: 'Bad Skill',
      }),
    ).rejects.toThrow("dispatchChatTurn: invalid skillName 'Bad Skill'");
    nothingWritten();
  });

  it('a frame no socket took fails the session no_client_ack and broadcasts nothing', async () => {
    state.delivered = 0;
    await expect(
      dispatchChatTurn({
        session: sessionOf(),
        project,
        client: { deviceId: 'd-1' },
        message: 'x',
      }),
    ).rejects.toMatchObject(refused('NO_CLAUDE_CLIENT'));
    expect(state.transitions.at(-1)).toMatchObject({
      to: 'failed',
      set: { failureReason: 'no_client_ack', updatedAt: NOW },
      reason: 'no_client_ack',
      actor: { type: 'system' },
      source: 'chat-turn',
    });
    expect(broadcastSession).not.toHaveBeenCalled();
  });
});
