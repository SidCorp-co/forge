/**
 * ISS-1286 — every shape a project's declared probes come back in.
 *
 * `fetch` is stubbed rather than a server stood up: what is under test is which of the four
 * readings each outcome becomes, and `verify.test.ts` already owns what `readProbe` does with a
 * response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveReleaseChannelsMock = vi.fn(async (_projectId: string) => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
vi.mock('./channel.js', async (importActual) => {
  const actual = await importActual<typeof import('./channel.js')>();
  return {
    ...actual,
    resolveReleaseChannels: (projectId: string) => resolveReleaseChannelsMock(projectId),
  };
});
const readForgeDeploymentsMock = vi.fn(
  async (_projectId: string): Promise<unknown> => ({
    kind: 'unrouted',
    missing: 'this project has no active deploy binding',
    route: 'bind a deploy binding Forge deploys through',
  }),
);
vi.mock('./deployed-reading.js', () => ({
  readForgeDeployments: (projectId: string) => readForgeDeploymentsMock(projectId),
}));
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => selectLimit() }) }) }) },
}));

const { declaredProbesOf, readServingNow, servedClause, servedCommits } = await import(
  './serving-reading.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVED = '0d98a6be6d9680b967d3f16542eadd25d02602cb';
const OTHER = 'da74b598bcae5a53a1c0f2b9e3d7a41f6c8b2d90';
const FROZEN = new Date('2026-09-26T23:55:00.000Z');
const now = () => FROZEN;

/** A live channel carrying the probes it declares, in the shape `resolveReleaseChannels` returns. */
function channel(over: Record<string, unknown> = {}) {
  return {
    bindingId: 'b1',
    provider: 'coolify',
    label: '',
    instructions: null,
    releaseRunnerLabel: null,
    verify: { probes: [{ url: 'https://one.test/health', commitPath: 'commit' }] },
    verifySource: 'binding',
    rollback: null,
    ...over,
  };
}

const answering = (bodies: Record<string, string>) =>
  vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    const body = bodies[`${url.origin}${url.pathname}`];
    if (body === undefined) throw new Error(`getaddrinfo ENOTFOUND ${url.hostname}`);
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  });

beforeEach(() => {
  readForgeDeploymentsMock.mockClear();
  resolveReleaseChannelsMock.mockReset();
  resolveReleaseChannelsMock.mockResolvedValue([]);
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('declaredProbesOf', () => {
  it('folds every channel probe into one config, keeping declaration order', () => {
    const declared = declaredProbesOf([
      channel(),
      channel({ verify: { probes: [{ url: 'https://two.test/health' }] } }),
    ] as never);
    expect(declared.cfg?.probes).toEqual([
      { url: 'https://one.test/health', commitPath: 'commit' },
      { url: 'https://two.test/health' },
    ]);
    expect(declared.refused).toBe(0);
  });

  it('asks one probe once where two channels declare the same one', () => {
    const declared = declaredProbesOf([channel(), channel({ bindingId: 'b2' })] as never);
    expect(declared.cfg?.probes).toHaveLength(1);
  });

  it('keeps two probes apart where only their commitPath differs', () => {
    const declared = declaredProbesOf([
      channel(),
      channel({ verify: { probes: [{ url: 'https://one.test/health', commitPath: 'sha' }] } }),
    ] as never);
    expect(declared.cfg?.probes).toHaveLength(2);
  });

  it('counts a refused declaration, which is not the same as declaring nothing', () => {
    const none = declaredProbesOf([channel({ verify: null, verifySource: 'none' })] as never);
    expect(none).toEqual({ cfg: null, refused: 0 });
    const refused = declaredProbesOf([
      channel({ verify: null, verifySource: 'declared-unusable' }),
    ] as never);
    expect(refused).toEqual({ cfg: null, refused: 1 });
  });
});

describe('readServingNow', () => {
  it('reads the commit every declared probe agrees on', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([channel()]);
    vi.stubGlobal('fetch', answering({ 'https://one.test/health': `{"commit":"${SERVED}"}` }));

    expect(await readServingNow(PROJECT_ID, now)).toEqual({
      kind: 'serving',
      served: [{ commit: SERVED, where: 'https://one.test/health' }],
      unread: [],
      readAt: FROZEN.toISOString(),
    });
  });

  it('reads a fleet that answers two commits as both of them, not as an absence', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel(),
      channel({ verify: { probes: [{ url: 'https://two.test/health', commitPath: 'commit' }] } }),
    ]);
    vi.stubGlobal(
      'fetch',
      answering({
        'https://one.test/health': `{"commit":"${SERVED}"}`,
        'https://two.test/health': `{"commit":"${OTHER}"}`,
      }),
    );

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading).toMatchObject({
      kind: 'serving',
      served: [
        { commit: SERVED, where: 'https://one.test/health' },
        { commit: OTHER, where: 'https://two.test/health' },
      ],
      unread: [],
    });
  });

  /**
   * ISS-1286 F3 — `readLiveState` returns neither an identity nor a disagreement here, and reading
   * that as an absence would earn a verdict naming a commit the answering probe contradicts.
   */
  it('keeps the commit one probe answered when another probe answers nothing', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel(),
      channel({ verify: { probes: [{ url: 'https://down.test/health', commitPath: 'commit' }] } }),
    ]);
    vi.stubGlobal('fetch', answering({ 'https://one.test/health': `{"commit":"${SERVED}"}` }));

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading).toMatchObject({
      kind: 'serving',
      served: [{ commit: SERVED, where: 'https://one.test/health' }],
    });
    expect(reading.kind === 'serving' && reading.unread.join(' ')).toContain('down.test');
  });

  it('says undeclared, and what is missing, where nothing declares a probe and nothing Forge deployed can answer', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([]);
    selectLimit.mockResolvedValue([{ environments: { live: { url: 'https://app.test' } } }]);
    expect(await readServingNow(PROJECT_ID, now)).toEqual({
      kind: 'undeclared',
      missing: 'this project has no active deploy binding',
      route: 'bind a deploy binding Forge deploys through',
    });
  });

  // ISS-1346: with no probe declared, what Forge itself deployed is what is asked.
  it('reads what Forge deployed where no probe is declared', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([channel({ verify: null, verifySource: 'none' })]);
    const where =
      "Coolify target `App` (preview), Forge's deployment d1 finished 2026-09-29T19:21:18.158Z";
    readForgeDeploymentsMock.mockResolvedValueOnce({
      kind: 'answered',
      served: [{ commit: SERVED, where }],
      unread: ['Coolify target `Api` (live) has no deployment Forge made and saw finish on record'],
    });
    expect(await readServingNow(PROJECT_ID, now)).toEqual({
      kind: 'serving',
      served: [{ commit: SERVED, where }],
      unread: ['Coolify target `Api` (live) has no deployment Forge made and saw finish on record'],
      readAt: FROZEN.toISOString(),
    });
    expect(readForgeDeploymentsMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('says unreadable, naming every target, where a route exists and nothing answered', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([]);
    readForgeDeploymentsMock.mockResolvedValueOnce({
      kind: 'unanswered',
      readFrom: ['one'],
      unread: [
        'one could not be read: 503',
        'two has no deployment Forge made and saw finish on record',
      ],
    });
    expect(await readServingNow(PROJECT_ID, now)).toEqual({
      kind: 'unreadable',
      why: 'one could not be read: 503; two has no deployment Forge made and saw finish on record',
      hosts: ['one'],
      readAt: FROZEN.toISOString(),
    });
  });

  it('never reads a deployment where a live binding declares a probe', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([channel()]);
    vi.stubGlobal('fetch', answering({ 'https://one.test/health': `{"commit":"${SERVED}"}` }));
    expect((await readServingNow(PROJECT_ID, now)).kind).toBe('serving');
    expect(readForgeDeploymentsMock).not.toHaveBeenCalled();
  });

  it('never reads a deployment where a declared probe was refused as a declaration', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel({ verify: null, verifySource: 'declared-unusable' }),
    ]);
    expect((await readServingNow(PROJECT_ID, now)).kind).toBe('unreadable');
    expect(readForgeDeploymentsMock).not.toHaveBeenCalled();
  });

  // `resolveReleaseChannels` reads no project row when there is no live binding, so this would
  // otherwise read as a project that declared no way to ask.
  it('falls back to the live environment probe where the project has no live binding', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([]);
    selectLimit.mockResolvedValue([
      { environments: { live: { commitUrl: 'https://env.test/health', commitPath: 'commit' } } },
    ]);
    vi.stubGlobal('fetch', answering({ 'https://env.test/health': `{"commit":"${SERVED}"}` }));

    expect(await readServingNow(PROJECT_ID, now)).toMatchObject({
      kind: 'serving',
      served: [{ commit: SERVED, where: 'https://env.test/health' }],
    });
  });

  it('reads an unreachable host as unreadable, naming the host and the moment', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([channel()]);
    vi.stubGlobal('fetch', answering({}));

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind).toBe('unreadable');
    expect(reading).toMatchObject({
      hosts: ['https://one.test/health'],
      readAt: FROZEN.toISOString(),
    });
    expect(reading.kind === 'unreadable' && reading.why).toContain('unreachable');
  });

  it('reads a 200 with no commit in it as unreadable rather than as a host that is down', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([channel()]);
    vi.stubGlobal('fetch', answering({ 'https://one.test/health': '{"version":"1.2.3"}' }));

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind === 'unreadable' && reading.why).toContain('held no commit');
    expect(reading.kind === 'unreadable' && reading.why).not.toContain('unreachable');
  });

  // ISS-1286 — a probe nobody can ask must not silence one somebody can.
  it('asks the probes it can and keeps their commit beside a url that is not a url', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel({
        verify: {
          probes: [{ url: 'not-a-url' }, { url: 'https://one.test/health', commitPath: 'commit' }],
        },
      }),
    ]);
    vi.stubGlobal('fetch', answering({ 'https://one.test/health': `{"commit":"${SERVED}"}` }));

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading).toMatchObject({
      kind: 'serving',
      served: [{ commit: SERVED, where: 'https://one.test/health' }],
    });
    expect(reading.kind === 'serving' && reading.unread.join(' ')).toContain('not-a-url');
  });

  it('names a probe url that is not a url as a declaration defect', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel({ verify: { probes: [{ url: 'not-a-url', commitPath: 'commit' }] } }),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind === 'unreadable' && reading.why).toContain('not-a-url');
    expect(reading.kind === 'unreadable' && reading.why).toContain('not a url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says nothing could be read where the only usable probe answered nothing either', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel({ verify: { probes: [{ url: 'not-a-url' }, { url: 'https://one.test/health' }] } }),
    ]);
    vi.stubGlobal('fetch', answering({}));

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind).toBe('unreadable');
    expect(reading.kind === 'unreadable' && reading.why).toContain('not-a-url');
    expect(reading.kind === 'unreadable' && reading.why).toContain('unreachable');
  });

  it('separates a declaration this repo refused from a project declaring nothing', async () => {
    resolveReleaseChannelsMock.mockResolvedValue([
      channel({ verify: null, verifySource: 'declared-unusable' }),
    ]);
    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind).toBe('unreadable');
    expect(reading.kind === 'unreadable' && reading.why).toContain('refused as a declaration');
  });
});

// ISS-1346 judge finding 2 — a commit is said beside where it runs, never as a bare list.
describe('servedClause', () => {
  it('groups every place a commit runs under that commit, in the order first answered', () => {
    const served = [
      { commit: SERVED, where: 'App (preview)' },
      { commit: OTHER, where: 'Web (live)' },
      { commit: OTHER, where: 'Home (live)' },
    ];
    expect(servedClause(served)).toBe(
      `\`${SERVED}\` at App (preview); \`${OTHER}\` at Web (live) and Home (live)`,
    );
  });

  // ISS-1346 criterion 25: one commit answered full by one source and short by another.
  it('names one commit answered in two spellings once, under the longest', () => {
    const served = [
      { commit: SERVED.slice(0, 7), where: 'https://one.test/health' },
      { commit: SERVED, where: 'Web (live)' },
    ];
    expect(servedClause(served)).toBe(`\`${SERVED}\` at https://one.test/health and Web (live)`);
  });

  it('names each distinct commit once, however many places run it', () => {
    const reading = {
      kind: 'serving' as const,
      served: [
        { commit: OTHER, where: 'a' },
        { commit: SERVED, where: 'b' },
        { commit: OTHER, where: 'c' },
      ],
      unread: [],
      readAt: FROZEN.toISOString(),
    };
    expect(servedCommits(reading)).toEqual([OTHER, SERVED]);
    expect(servedCommits({ kind: 'undeclared', missing: 'm', route: 'r' })).toEqual([]);
  });
});
