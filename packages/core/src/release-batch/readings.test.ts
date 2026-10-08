// What Forge keeps of a look, and how it is read back (ISS-1282). The store is stubbed at the
// database seam; what is under test is what is written, what is read per binding, and that a stored
// shape this code cannot read is refused by name and never guessed into one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inserted = vi.fn();
const selected = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => ({
        returning: async () => {
          inserted(v);
          return [
            {
              id: 'reading-1',
              runId: 'run-1',
              takenAt: new Date('2026-10-08T10:00:00.000Z'),
              takenBy: 'u-1',
              ...(v as object),
            },
          ];
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ orderBy: async () => selected() }) }),
    }),
  },
}));
vi.mock('../knowledge/service.js', () => ({ getKnowledgeEntry: async () => null }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  inserted.mockReset();
  selected.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const {
  commitsBeforeOf,
  judgeRecordedReadings,
  listReadings,
  readCommitsBefore,
  takeReading,
  viewOf,
} = await import('./readings.js');
const { ReleaseReadingUnreadableError } = await import('./errors.js');

const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const OLD = 'a12b34c5d6e7f8091a2b3c4d5e6f708192a3b4c5';

const channel = (id: string, url: string, over: Record<string, unknown> = {}) => ({
  bindingId: id,
  provider: 'coolify',
  label: id === 'b-1' ? '' : 'eu',
  instructions: null,
  releaseRunnerLabel: null,
  verify: { probes: [{ url, commitPath: 'commit' }], ...over },
  verifySource: 'binding' as const,
  rollback: null,
});

/** A server answering each url with the commit it is told to. */
function serving(byHost: Record<string, string | 'down'>) {
  fetchMock.mockImplementation(async (input: URL) => {
    const say = byHost[new URL(String(input)).host];
    if (say === 'down') return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ commit: say }) };
  });
}

describe('takeReading — one read per binding that declares a probe', () => {
  const a = channel('b-1', 'https://one.test/version');
  const b = channel('b-2', 'https://two.test/version');

  it('stores what each binding said under its own id, and the bindings nothing read', async () => {
    serving({ 'one.test': NEW, 'two.test': OLD });
    const unread = { ...channel('b-3', 'https://x.test/v'), verify: null };

    const reading = await takeReading({
      runId: 'run-1',
      takenBy: 'u-1',
      verification: { kind: 'probed', channels: [a, b], unread: [unread] } as never,
    });

    const written = inserted.mock.calls[0]?.[0] as {
      bindings: Array<{ bindingId: string; name: string; state: { identity: string | null } }>;
      unread: string[];
      takenBy: string;
    };
    expect(written.takenBy).toBe('u-1');
    expect(written.bindings.map((x) => [x.bindingId, x.state.identity])).toEqual([
      ['b-1', NEW],
      ['b-2', OLD],
    ]);
    expect(written.bindings[1]?.name).toBe('coolify [eu] b-2');
    expect(written.unread).toEqual(['coolify [eu] b-3']);
    expect(reading.bindings).toHaveLength(2);
    expect(reading.id).toBe('reading-1');
  });

  it('keeps a binding that did not answer as a reading of an application not answering', async () => {
    serving({ 'one.test': NEW, 'two.test': 'down' });

    const reading = await takeReading({
      runId: 'run-1',
      takenBy: 'u-1',
      verification: { kind: 'probed', channels: [a, b], unread: [] } as never,
    });

    expect(reading.bindings[1]?.state.health).toBe('down');
    expect(reading.bindings[1]?.state.unhealthy.join()).toContain('http 503');
    expect(reading.bindings[0]?.state.identity).toBe(NEW);
  });

  it('reads every binding, not the first, and each probe once', async () => {
    serving({ 'one.test': NEW, 'two.test': NEW });

    await takeReading({
      runId: 'run-1',
      takenBy: 'u-1',
      verification: { kind: 'probed', channels: [a, b], unread: [] } as never,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('readCommitsBefore — what each binding served before anything moved', () => {
  it('answers one commit per binding id, null where a binding answered none', async () => {
    serving({ 'one.test': OLD, 'two.test': 'down' });

    const before = await readCommitsBefore([
      channel('b-1', 'https://one.test/version'),
      channel('b-2', 'https://two.test/version'),
    ] as never);

    expect(before).toEqual({ 'b-1': OLD, 'b-2': null });
  });
});

describe('commitsBeforeOf', () => {
  it('reads the map a batch recorded', () => {
    expect(commitsBeforeOf({ commitBeforeBy: { 'b-1': OLD, 'b-2': null } })).toEqual({
      'b-1': OLD,
      'b-2': null,
    });
  });

  it('reads a run that recorded none as recording nothing, never as a commit', () => {
    expect(commitsBeforeOf({})).toEqual({});
    expect(commitsBeforeOf(null)).toEqual({});
    expect(commitsBeforeOf({ commitBeforeBy: 'abc' })).toEqual({});
    expect(commitsBeforeOf({ commitBeforeBy: [OLD] })).toEqual({});
  });

  it('does not read the single commitBefore a batch opened before readings were kept', () => {
    expect(commitsBeforeOf({ commitBefore: OLD })).toEqual({});
  });

  it('keeps a non-string entry as no commit rather than as its value', () => {
    expect(commitsBeforeOf({ commitBeforeBy: { 'b-1': 7, 'b-2': OLD } })).toEqual({
      'b-1': null,
      'b-2': OLD,
    });
  });
});

const state = {
  health: 'up',
  identity: NEW,
  answeredBy: [{ url: 'https://one.test/version', commit: NEW }],
  readings: ['https://one.test/version -> x'],
  unhealthy: [],
  unidentified: [],
  disagreement: null,
};

describe('listReadings', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'reading-1',
    runId: 'run-1',
    takenAt: new Date('2026-10-08T10:00:00.000Z'),
    takenBy: 'u-1',
    bindings: [{ bindingId: 'b-1', name: 'coolify b-1', state }],
    unread: [],
    ...over,
  });

  it('reads each stored row back as a reading, oldest first as the store gives them', async () => {
    selected.mockResolvedValue([row(), row({ id: 'reading-2' })]);

    const all = await listReadings('run-1');

    expect(all.map((r) => r.id)).toEqual(['reading-1', 'reading-2']);
    expect(all[0]?.bindings[0]?.state.identity).toBe(NEW);
  });

  it.each([
    ['a binding with no state', { bindings: [{ bindingId: 'b-1', name: 'x' }] }],
    [
      'a health that is neither up nor down',
      { bindings: [{ bindingId: 'b-1', name: 'x', state: { ...state, health: 'maybe' } }] },
    ],
    ['bindings that are not a list', { bindings: { 'b-1': state } }],
    ['unread that is not a list of names', { unread: [1, 2] }],
  ])('refuses %s by naming the row, and never guesses it into a reading', async (_why, over) => {
    selected.mockResolvedValue([row(over)]);

    await expect(listReadings('run-1')).rejects.toThrow(ReleaseReadingUnreadableError);
    await expect(listReadings('run-1')).rejects.toThrow(
      /RELEASE_READING_UNREADABLE: the stored reading reading-1/,
    );
  });

  it('answers none for a run nobody looked at', async () => {
    selected.mockResolvedValue([]);

    expect(await listReadings('run-1')).toEqual([]);
  });
});

describe('viewOf — a reading as an answer carries it', () => {
  it('lays each binding’s probes beside its id and name, and the time as text', () => {
    const view = viewOf({
      id: 'reading-1',
      runId: 'run-1',
      takenAt: new Date('2026-10-08T10:00:00.000Z'),
      takenBy: 'u-1',
      unread: ['coolify [eu] b-3'],
      bindings: [{ bindingId: 'b-1', name: 'coolify b-1', state: state as never }],
    });

    expect(view).toEqual({
      id: 'reading-1',
      takenAt: '2026-10-08T10:00:00.000Z',
      takenBy: 'u-1',
      unread: ['coolify [eu] b-3'],
      bindings: [{ bindingId: 'b-1', name: 'coolify b-1', ...state }],
    });
  });
});

describe('judgeRecordedReadings — the readings the database holds, judged by the declared stableReads', () => {
  const stored = (id: string, at: string, identity: string) => ({
    id,
    runId: 'run-1',
    takenAt: new Date(at),
    takenBy: 'u-1',
    bindings: [{ bindingId: 'b-1', name: 'coolify b-1', state: { ...state, identity } }],
    unread: [],
  });
  const verification = (stableReads?: number) =>
    ({
      kind: 'probed',
      unread: [],
      channels: [channel('b-1', 'https://one.test/version', stableReads ? { stableReads } : {})],
    }) as never;
  const NOW = Date.parse('2026-10-08T10:01:00.000Z');
  const args = (v: unknown, claim: string | null = NEW) => ({
    runId: 'run-1',
    metadata: { commitBeforeBy: { 'b-1': OLD } },
    verification: v as never,
    claim,
    now: NOW,
  });

  it('asks two consecutive readings of a binding that declares no stableReads', async () => {
    selected.mockResolvedValue([stored('r-1', '2026-10-08T10:00:00.000Z', NEW)]);

    const out = await judgeRecordedReadings(args(verification()));

    expect(out).toMatchObject({ ok: false });
    expect(out.ok === false && out.reason).toContain('1 of the 2 consecutive readings');
  });

  it('asks as many as the binding declares', async () => {
    selected.mockResolvedValue([stored('r-1', '2026-10-08T10:00:00.000Z', NEW)]);

    expect(await judgeRecordedReadings(args(verification(1)))).toMatchObject({
      ok: true,
      evidence: ['r-1'],
    });
  });

  it('judges against the build the batch recorded for that binding', async () => {
    selected.mockResolvedValue([
      stored('r-1', '2026-10-08T10:00:00.000Z', OLD),
      stored('r-2', '2026-10-08T10:00:10.000Z', OLD),
    ]);

    const out = await judgeRecordedReadings(args(verification(), null));

    expect(out.ok === false && out.reason).toContain('the live build is unchanged');
  });

  it('has nothing to compare where the batch recorded no earlier build and no commit is named', async () => {
    selected.mockResolvedValue([
      stored('r-1', '2026-10-08T10:00:00.000Z', NEW),
      stored('r-2', '2026-10-08T10:00:10.000Z', NEW),
    ]);

    const out = await judgeRecordedReadings({ ...args(verification(), null), metadata: {} });

    expect(out.ok === false && out.reason).toContain('nothing recorded what was serving');
  });

  it('is judged at the time it is handed, defaulting to now', async () => {
    selected.mockResolvedValue([
      stored('r-1', '2020-01-01T00:00:00.000Z', NEW),
      stored('r-2', '2020-01-01T00:00:10.000Z', NEW),
    ]);

    const out = await judgeRecordedReadings({ ...args(verification()), now: undefined });

    expect(out.ok === false && out.reason).toContain('minutes old');
  });
});
