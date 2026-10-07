import type {
  ContractAdoption,
  ContractAttentionGroup,
  ContractDirection,
  ContractProjectRef,
  ContractState,
  ContractVersionRef,
  ContractWaitingKind,
  ContractWindow,
} from '@forge/contracts/contract-standing';
import { say } from '@forge/contracts/said';
import { type WaitingOn, type WaitingSays, waitingOn } from '@forge/contracts/standing';

type ContractWaitingOn = WaitingOn<ContractWaitingKind>;

export interface VersionFact {
  version: string;
  recordedAt: Date;
  classification: string;
  approval: string;
  decidedAt: Date | null;
}

export interface ConsumerFact {
  project: ContractProjectRef;
  builtAgainst: string;
}

interface ChangeFact {
  feedback: string;
  version: string;
  dueAt: Date;
  open: boolean;
}

export interface ContractFacts {
  direction: ContractDirection;
  providerSlug: string;
  lifecycle: string;
  versions: readonly VersionFact[];
  ours: string | null;
  windowDues: ReadonlyMap<string, Date>;
  change: ChangeFact | null;
  consumers: readonly ConsumerFact[];
}

export interface StandingViewer {
  decides: (classification: string) => boolean;
  acts: boolean;
}

export interface Standing {
  current: VersionFact | null;
  pending: VersionFact | null;
  ours: string | null;
  window: ContractWindow | null;
  state: ContractState;
  attentionGroup: ContractAttentionGroup;
  waitingOn: ContractWaitingOn;
  adoption: ContractAdoption[];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export const versionRef = (v: VersionFact): ContractVersionRef => ({
  version: v.version,
  recordedAt: v.recordedAt.toISOString(),
  classification: v.classification,
  approval: v.approval,
  decidedAt: v.decidedAt?.toISOString() ?? null,
});

// `contract/store.ts:currentOf` — the newest approved version is current; a proposed or returned one never is
const currentOf = (versions: readonly VersionFact[]) =>
  versions.find((v) => v.approval === 'approved') ?? null;

function pendingOf(versions: readonly VersionFact[], current: VersionFact | null) {
  const p = versions.find((v) => v.approval === 'proposed');
  if (!p) return null;
  return !current || p.recordedAt > current.recordedAt ? p : null;
}

// a provider's window is the due date `contract/announce.ts:fileBreakingIn` stamped on its consumers' items for the current breaking version; a consumer's is its own item's, so both sides read one recorded date and neither recomputes it from today's notice days
function windowOf(f: ContractFacts, current: VersionFact | null, now: Date): ContractWindow | null {
  if (f.direction === 'consumed') {
    if (!f.change) return null;
    return {
      version: f.change.version,
      dueAt: f.change.dueAt.toISOString(),
      open: now < f.change.dueAt,
    };
  }
  const due =
    current?.classification === 'breaking' ? f.windowDues.get(current.version) : undefined;
  if (!current || !due) return null;
  return { version: current.version, dueAt: due.toISOString(), open: now < due };
}

function adoptionOf(
  builtAgainst: string,
  current: VersionFact | null,
  window: ContractWindow | null,
): ContractAdoption {
  if (!current) return 'unpublished';
  if (builtAgainst === current.version) return 'current';
  return window?.open && window.version === current.version ? 'owes' : 'behind';
}

function stateOf(
  f: ContractFacts,
  current: VersionFact | null,
  pending: VersionFact | null,
  window: ContractWindow | null,
): ContractState {
  if (f.direction === 'provided') {
    if (pending) return 'proposed';
    if (window?.open) return 'breaking_pending';
  } else if (f.change?.open) {
    return 'breaking_pending';
  }
  if (f.lifecycle === 'deprecated') return 'deprecated';
  if (!current) return 'unpublished';
  if (f.direction === 'consumed' && f.ours !== current.version) return 'behind';
  return 'published';
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface Turn {
  group: ContractAttentionGroup;
  waitingOn: ContractWaitingOn;
}

const turn = (
  group: ContractAttentionGroup,
  kind: ContractWaitingOn['kind'],
  says: WaitingSays,
  at: { ref?: string | null; dueAt?: string | null } = {},
): Turn => ({ group, waitingOn: waitingOn(kind, says, at) });

const YOU = say('standing.who.you');
const NOBODY = say('standing.who.nobody');

function providedTurn(
  f: ContractFacts,
  v: StandingViewer,
  current: VersionFact | null,
  pending: VersionFact | null,
  window: ContractWindow | null,
  adoption: readonly ContractAdoption[],
): Turn {
  if (pending) {
    const act = say('contracts.act.approveOrReturn', {
      v: pending.version,
      measured: pending.classification,
    });
    const rule = say('contracts.rule.proposed');
    return v.decides(pending.classification)
      ? turn('needs_you', 'you', { who: YOU, act, rule }, { ref: pending.version })
      : turn(
          'waiting',
          'person',
          { who: say('contracts.who.orgAdmin'), act, rule },
          { ref: pending.version },
        );
  }
  const owing = f.consumers.filter((_, i) => adoption[i] === 'owes');
  if (window?.open && owing.length > 0) {
    const who =
      owing.length === 1
        ? say('standing.who.named', { name: (owing[0] as ConsumerFact).project.slug })
        : say('contracts.who.consumers', { n: owing.length });
    return turn(
      'waiting',
      'project',
      {
        who,
        act: say('contracts.act.adoptBy', { v: window.version, date: window.dueAt.slice(0, 10) }),
        rule: say('contracts.rule.window'),
      },
      { ref: window.version, dueAt: window.dueAt },
    );
  }
  const behind = adoption.filter((a) => a !== 'current').length;
  const act =
    f.consumers.length === 0
      ? say('contracts.act.noConsumer')
      : behind === 0 && current
        ? say('contracts.act.everyConsumerOn', { v: current.version })
        : say('contracts.act.behind', {
            n: behind,
            total: f.consumers.length,
            consumers: plural(f.consumers.length, 'consumer', 'consumers'),
          });
  return turn('steady', 'none', { who: NOBODY, act, rule: say('contracts.rule.providedSteady') });
}

function consumedTurn(f: ContractFacts, v: StandingViewer, current: VersionFact | null): Turn {
  const change = f.change;
  if (change?.open) {
    const act = say('contracts.act.adaptBy', { v: change.version, date: day(change.dueAt) });
    const rule = say('contracts.rule.breaking');
    const at = { ref: change.feedback, dueAt: change.dueAt.toISOString() };
    return v.acts
      ? turn('needs_you', 'you', { who: YOU, act, rule }, at)
      : turn('waiting', 'person', { who: say('contracts.who.projectMember'), act, rule }, at);
  }

  const act = !current
    ? say('contracts.act.noVersion')
    : f.ours === current.version
      ? say('contracts.act.onLatest', { v: current.version })
      : f.ours
        ? say('contracts.act.builtAgainst', { ours: f.ours, v: current.version })
        : say('contracts.act.builtAgainstNone', { v: current.version });
  return turn('steady', 'none', { who: NOBODY, act, rule: say('contracts.rule.consumedSteady') });
}

export function standingOf(f: ContractFacts, viewer: StandingViewer, now: Date): Standing {
  const current = currentOf(f.versions);
  const pending = f.direction === 'provided' ? pendingOf(f.versions, current) : null;
  const window = windowOf(f, current, now);
  const adoption = f.consumers.map((c) => adoptionOf(c.builtAgainst, current, window));
  const turn =
    f.direction === 'provided'
      ? providedTurn(f, viewer, current, pending, window, adoption)
      : consumedTurn(f, viewer, current);
  return {
    current,
    pending,
    ours: f.direction === 'provided' ? (current?.version ?? null) : f.ours,
    window,
    state: stateOf(f, current, pending, window),
    attentionGroup: turn.group,
    waitingOn: turn.waitingOn,
    adoption,
  };
}
