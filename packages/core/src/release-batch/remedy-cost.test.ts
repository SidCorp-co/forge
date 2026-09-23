/**
 * What a remedy costs, and that no message hides one.
 *
 * ISS-1127 shipped the defect it was filed about: `RELEASE_RUNNER_PREFERENCE_UNMET`
 * called itself a reason that stops nothing and offered withdrawing the release
 * label as one of two equal ways out, while withdrawing it raises
 * `RELEASE_RUNNER_UNDECLARED`, a 409. The three scans below are the property
 * that was missing — a message may name a foreign code or a foreign act only
 * where `REMEDY_COST` declares it — and the last case drives the one declared
 * act through every branch the check reading it takes, so `raises` being a
 * single code is measured rather than assumed.
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
  'RELEASE_RUNNER_UNDECLARED',
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

/** The reasons this message describes an act towards without declaring it. */
function trespassingIn(code: ReasonCode, message: string): string[] {
  const acts = Object.entries(REMEDY_COST).flatMap(([owner, costs]) =>
    costs.map((cost) => ({ owner, cost })),
  );
  const rest = withoutDeclaredClauses(code, message).toLowerCase();
  return acts
    .filter(({ owner }) => owner !== code)
    .filter(({ cost }) => cost.worded.some((w) => rest.includes(w.toLowerCase())))
    .map(({ cost }) => cost.raises);
}

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

  // The words the shipped defect used and the words a reviewer reached for are
  // not the same words, which is why `worded` holds stems and not sentences.
  it.each([
    'Send `null` for that key to withdraw it again.',
    'Withdraw the release runner label to go back.',
    'You may withdraw this at any time.',
  ])('catches an undeclared withdrawal written as %s', (planted) => {
    expect(trespassingIn('RELEASE_POOL_EMPTY', `${REMEDY_POOL_EMPTY} ${planted}`)).toEqual([
      'RELEASE_RUNNER_UNDECLARED',
    ]);
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

describe('the act RELEASE_RUNNER_PREFERENCE_UNMET names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRow();
    selectRows.mockResolvedValue([]);
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue(['dev-1']);
  });

  for (const { branch, declared } of LABEL_BRANCHES) {
    // The act is worded to cover the binding AND the connection behind it, so
    // that is what is taken here. Withdrawing from one of the two is the case
    // below, and it is why the act names both.
    it(`raises RELEASE_RUNNER_UNDECLARED and nothing else new where ${branch}`, async () => {
      const before = await codesFor(declared);
      const withdrawn = declared.map((d) => binding(d.binding.id, { ...REST }, {}));

      const after = await codesFor(withdrawn);

      expect(after).toContain('RELEASE_RUNNER_UNDECLARED');
      expect(after.filter((c) => !before.includes(c))).toEqual(['RELEASE_RUNNER_UNDECLARED']);
    });
  }

  // Sending `releaseRunnerLabel: null` to the integrations PATCH drops the key
  // from the BINDING, and `effectiveConfig` falls back to the connection's. A
  // half-withdrawal therefore raises nothing and clears nothing, which is why
  // the act names both places rather than the one route.
  it('changes nothing where only the binding is withdrawn and the connection still declares one', async () => {
    const declared = [
      binding('b-1', { ...REST, releaseRunnerLabel: 'release' }, { releaseRunnerLabel: 'other' }),
    ];
    const before = await codesFor(declared);

    const after = await codesFor([binding('b-1', { ...REST }, { releaseRunnerLabel: 'other' })]);

    expect(after).not.toContain('RELEASE_RUNNER_UNDECLARED');
    expect(after).toEqual(before);
  });
});
