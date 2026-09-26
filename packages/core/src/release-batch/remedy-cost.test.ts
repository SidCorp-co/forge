/**
 * What a remedy costs, and that no message hides one.
 *
 * ISS-1127 shipped the defect it was filed about: `RELEASE_RUNNER_PREFERENCE_UNMET`
 * called itself a reason that stops nothing and offered withdrawing the release
 * label as one of two equal ways out, while withdrawing it raised
 * `RELEASE_RUNNER_UNDECLARED`, a 409. The three scans below are the property
 * that was missing — a message may name a foreign code or a foreign act only
 * where `REMEDY_COST` declares it.
 *
 * ISS-1275 then made that withdrawal free, so the table declares no act and a
 * scan over it is green for every input. The planted cases drive it against a
 * FIXTURE table, and the same plant against the shipped one is asserted clean.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const execRows = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Object.assign(selectRows(), { limit: selectLimit }) }),
    }),
    execute: () => execRows(),
  },
}));

const listBindings = vi.fn(async () => [] as unknown[]);
vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const onlineIds = vi.fn(async () => [] as string[]);
vi.mock('../runners/select.js', () => ({
  onlineCapableDeviceIds: (...a: unknown[]) => onlineIds(...(a as [])),
}));

const {
  collectReleaseBlockers,
  heldBackWarningSentence,
  REMEDY_COST,
  releaseBlockerSentence,
  remedyCostClause,
  runnerPreferenceUnmetSentence,
} = await import('./blockers.js');
type RemedyAct = import('./blockers.js').RemedyAct;
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

type ReasonCode = keyof typeof REMEDY_COST;

/** Written out so a code removed from the union fails to compile and one added fails the count. */
const BLOCKER_CODES = [
  'NO_RELEASE_GATE',
  'RELEASE_TARGET_UNDECLARED',
  'CLAIM_CONFLICT',
  'RELEASE_ROSTER_EMPTY',
  'RELEASE_ROSTER_OVERSIZE',
  'RELEASE_RECORD_MISSING',
  'RELEASE_WORK_UNMERGED',
  'RELEASE_RUNNER_AMBIGUOUS',
  'RELEASE_PROBES_UNDECLARED',
  'RELEASE_PROBES_UNREADABLE',
  'RELEASE_POOL_EMPTY',
  'NO_RUNNER_ONLINE',
  'RELEASE_BRANCHES_UNDECLARED',
  'RELEASE_MULTI_CHANNEL_UNSUPPORTED',
  'BATCH_IN_FLIGHT',
  'RELEASE_CRITERIA_UNEARNED',
  'RELEASE_CHECK_UNEVALUATED',
] as const;

const WARNING_CODES = ['RELEASE_RUNNER_PREFERENCE_UNMET', 'RELEASE_CRITERIA_HELD_BACK'] as const;

const HELD = [{ issueId: 'u-9', displayId: 'ISS-9', criteria: [1, 2] }];

/** Every message this project can print, code by code, composed as its door composes it. */
function everyMessage(): Array<{ code: ReasonCode; message: string }> {
  return [
    ...BLOCKER_CODES.map((code) => ({
      code: code as ReasonCode,
      message: releaseBlockerSentence(code),
    })),
    {
      code: 'RELEASE_ROSTER_EMPTY' as ReasonCode,
      message: releaseBlockerSentence('RELEASE_ROSTER_EMPTY', { nearGate: 3 }),
    },
    {
      code: 'RELEASE_CRITERIA_UNEARNED' as ReasonCode,
      message: releaseBlockerSentence('RELEASE_CRITERIA_UNEARNED', { held: HELD }),
    },
    {
      code: 'RELEASE_RUNNER_AMBIGUOUS' as ReasonCode,
      message: releaseBlockerSentence('RELEASE_RUNNER_AMBIGUOUS', { labels: ['a', 'b'] }),
    },
    {
      code: 'RELEASE_RUNNER_PREFERENCE_UNMET' as ReasonCode,
      message: runnerPreferenceUnmetSentence('release'),
    },
    { code: 'RELEASE_CRITERIA_HELD_BACK' as ReasonCode, message: heldBackWarningSentence(HELD) },
  ];
}

/** The message with every clause the table put there removed, which is what the scans read. */
function withoutDeclaredClauses(code: ReasonCode, message: string): string {
  let rest = message;
  for (const cost of REMEDY_COST[code]) rest = rest.replace(remedyCostClause(cost), '');
  return rest;
}

type RemedyTable = Record<string, readonly RemedyAct[]>;

/** The reasons this message describes an act towards without declaring it.
 *  `table` is the shipped `REMEDY_COST` everywhere but the planted cases. */
function trespassingIn(
  code: ReasonCode,
  message: string,
  table: RemedyTable = REMEDY_COST,
): string[] {
  const acts = Object.entries(table).flatMap(([owner, costs]) =>
    costs.map((cost) => ({ owner, cost })),
  );
  const rest = withoutDeclaredClauses(code, message).toLowerCase();
  return acts
    .filter(({ owner }) => owner !== code)
    .filter(({ cost }) => cost.worded.some((w) => rest.includes(w.toLowerCase())))
    .map(({ cost }) => cost.raises);
}

/** One declared act, so the scans have something to find. `worded` holds stems
 *  because the defect's words and a reviewer's were not the same words. */
const PLANTED_ACT: RemedyAct = {
  act: 'Withdrawing the label instead, by sending `releaseRunnerLabel` as `null` on every live deploy binding,',
  worded: ['withdraw', 'withdrawing'],
  raises: 'RELEASE_POOL_EMPTY',
};
const PLANTED_TABLE: RemedyTable = { RELEASE_RUNNER_PREFERENCE_UNMET: [PLANTED_ACT] };

const REMEDY_POOL_EMPTY = releaseBlockerSentence('RELEASE_POOL_EMPTY');

describe('REMEDY_COST', () => {
  it('answers for every reason this project prints, and for no other', () => {
    expect(new Set(Object.keys(REMEDY_COST))).toEqual(
      new Set<string>([...BLOCKER_CODES, ...WARNING_CODES]),
    );
  });

  it('puts every declared cost into that code’s own message, word for word', () => {
    for (const { code, message } of everyMessage()) {
      for (const cost of REMEDY_COST[code]) {
        expect(message).toContain(remedyCostClause(cost));
      }
    }
  });

  it('lets no message name another reason except in a clause the table composed', () => {
    const names = [...BLOCKER_CODES, ...WARNING_CODES];
    for (const { code, message } of everyMessage()) {
      const rest = withoutDeclaredClauses(code, message);
      const named = names.filter((n) => n !== code && rest.includes(n));
      expect({ code, named }).toEqual({ code, named: [] });
    }
  });

  it('lets no message carry an act declared against a different reason', () => {
    for (const { code, message } of everyMessage()) {
      expect({ code, trespassing: trespassingIn(code, message) }).toEqual({
        code,
        trespassing: [],
      });
    }
  });

  it('declares no act at all, every remedy this project prints being free', () => {
    expect(Object.values(REMEDY_COST).flat()).toEqual([]);
  });

  it.each([
    'Send `null` for that key to withdraw it again.',
    'Withdraw the release runner label to go back.',
    'You may withdraw this at any time.',
  ])('catches an undeclared withdrawal written as %s', (planted) => {
    expect(
      trespassingIn('RELEASE_POOL_EMPTY', `${REMEDY_POOL_EMPTY} ${planted}`, PLANTED_TABLE),
    ).toEqual(['RELEASE_POOL_EMPTY']);
  });

  it.each([
    'Send `null` for that key to withdraw it again.',
    'Withdraw the release runner label to go back.',
    'You may withdraw this at any time.',
  ])('finds nothing to charge for the same sentence, shipped: %s', (planted) => {
    expect(trespassingIn('RELEASE_POOL_EMPTY', `${REMEDY_POOL_EMPTY} ${planted}`)).toEqual([]);
  });

  // And a message describing no act is clean against the table that declares one.
  it('charges nothing to a message that describes no declared act', () => {
    expect(trespassingIn('RELEASE_POOL_EMPTY', REMEDY_POOL_EMPTY, PLANTED_TABLE)).toEqual([]);
  });
});

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const PROBES = { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] };

function projectRow() {
  selectLimit.mockResolvedValue([
    {
      repoPath: '/srv/app',
      repoUrl: null,
      baseBranch: 'main',
      liveBranch: null,
      releaseModel: 'publish',
      releaseStrategy: null,
      environments: {
        live: { url: 'https://app.test', commitUrl: 'https://example.test/api/health' },
      },
    },
  ]);
}

function binding(id: string, config: Record<string, unknown>, connection: Record<string, unknown>) {
  return {
    binding: {
      id,
      provider: 'coolify',
      config,
      instructions: null,
      label: '',
      role: 'deploy',
      stages: ['live'],
    },
    connection: { config: connection },
  };
}

const REST = { verify: PROBES, rollback: { mode: 'coolify-image' } };

type Declared = ReturnType<typeof binding>;

/** The act itself: drop `releaseRunnerLabel` and leave every other key where it was. */
function withdrawReleaseRunnerLabel(declared: Declared[]): Declared[] {
  const drop = (config: Record<string, unknown>) => {
    const { releaseRunnerLabel: _gone, ...kept } = config;
    return kept;
  };
  return declared.map((d) =>
    binding(d.binding.id, drop(d.binding.config), drop(d.connection.config)),
  );
}

/**
 * Every way `resolveReleaseChannels` can arrive at a label: the binding's own
 * key, the connection's where the binding has none, both at once, and two live
 * bindings disagreeing. Read by hand off `effectiveConfig` and
 * `releaseRunnerLabelOf` in `channel.ts`, and NOT derived from them — a branch
 * added there leaves this table short in silence, and re-deriving it belongs to
 * that change. Priced rather than guarded: a structural check would have to
 * enumerate a resolver's branches from its source, which nothing here does.
 */
const LABEL_BRANCHES = [
  {
    branch: 'the binding declares it',
    declared: [binding('b-1', { ...REST, releaseRunnerLabel: 'release' }, {})],
  },
  {
    branch: 'the connection declares it',
    declared: [binding('b-1', REST, { releaseRunnerLabel: 'release' })],
  },
  {
    branch: 'both declare it',
    declared: [
      binding('b-1', { ...REST, releaseRunnerLabel: 'release' }, { releaseRunnerLabel: 'other' }),
    ],
  },
  {
    branch: 'two live bindings disagree',
    declared: [
      binding('b-1', { ...REST, releaseRunnerLabel: 'release' }, {}),
      binding('b-2', { ...REST, releaseRunnerLabel: 'other' }, {}),
    ],
  },
];

async function codesFor(bindings: unknown[]): Promise<string[]> {
  listBindings.mockResolvedValue(bindings);
  const report = await collectReleaseBlockers(PROJECT_ID);
  return report.blockers.map((b) => b.code);
}

describe('withdrawing the release runner label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRow();
    selectRows.mockResolvedValue([]);
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue(['dev-1']);
  });

  for (const { branch, declared } of LABEL_BRANCHES) {
    // Taken from the binding AND the connection: the half-withdrawal is below.
    it(`raises nothing new where ${branch}`, async () => {
      const before = await codesFor(declared);

      const after = await codesFor(withdrawReleaseRunnerLabel(declared));

      expect(after.filter((c) => !before.includes(c))).toEqual([]);
    });
  }

  // Sending `releaseRunnerLabel: null` to the integrations PATCH drops the key
  // from the BINDING, and `effectiveConfig` falls back to the connection's. A
  // half-withdrawal therefore raises nothing and clears nothing, which is why
  // the act names both places rather than the one route.
  // The operation is a key removal, not a config rewrite: a fixture that
  // rebuilt the config would pass while the real one dropped the probes.
  it('leaves every other key on the binding and the connection where it was', async () => {
    const declared = [
      binding(
        'b-1',
        { ...REST, releaseRunnerLabel: 'release' },
        { releaseRunnerLabel: 'other', apiKey: 'kept' },
      ),
    ];

    const [withdrawn] = withdrawReleaseRunnerLabel(declared);

    expect(withdrawn?.binding.config).toEqual(REST);
    expect(withdrawn?.connection.config).toEqual({ apiKey: 'kept' });
    expect(await codesFor(withdrawReleaseRunnerLabel(declared))).toEqual(await codesFor(declared));
  });

  it('changes nothing where only the binding is withdrawn and the connection still declares one', async () => {
    const declared = [
      binding('b-1', { ...REST, releaseRunnerLabel: 'release' }, { releaseRunnerLabel: 'other' }),
    ];
    const before = await codesFor(declared);

    const after = await codesFor([binding('b-1', { ...REST }, { releaseRunnerLabel: 'other' })]);

    expect(after).toEqual(before);
  });
});
