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
import type { WaitingOn } from '@forge/contracts/standing';

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

function providedTurn(
  f: ContractFacts,
  v: StandingViewer,
  current: VersionFact | null,
  pending: VersionFact | null,
  window: ContractWindow | null,
  adoption: readonly ContractAdoption[],
): Turn {
  if (pending) {
    const act = `approve or return ${pending.version} · measured ${pending.classification}`;
    const rule =
      'providedTurn: a recorded version is proposed until its approver decides it (contract/approval.ts:approverRefusal)';
    return v.decides(pending.classification)
      ? {
          group: 'needs_you',
          waitingOn: { kind: 'you', who: 'You', act, rule, ref: pending.version, dueAt: null },
        }
      : {
          group: 'waiting',
          waitingOn: {
            kind: 'person',
            who: 'An org admin',
            act,
            rule,
            ref: pending.version,
            dueAt: null,
          },
        };
  }
  const owing = f.consumers.filter((_, i) => adoption[i] === 'owes');
  if (window?.open && owing.length > 0) {
    const who =
      owing.length === 1 ? (owing[0] as ConsumerFact).project.slug : `${owing.length} consumers`;
    return {
      group: 'waiting',
      waitingOn: {
        kind: 'project',
        who,
        act: `adopt ${window.version} by ${window.dueAt.slice(0, 10)}`,
        rule: 'providedTurn: a breaking version is approved and a consumer is still built against an older one inside the window',
        ref: window.version,
        dueAt: window.dueAt,
      },
    };
  }
  const behind = adoption.filter((a) => a !== 'current').length;
  const act =
    f.consumers.length === 0
      ? 'no consumer yet'
      : behind === 0 && current
        ? `every consumer is on ${current.version}`
        : `${behind} of ${f.consumers.length} ${plural(f.consumers.length, 'consumer', 'consumers')} behind, no window open`;
  return {
    group: 'steady',
    waitingOn: {
      kind: 'none',
      who: 'Nobody',
      act,
      rule: 'providedTurn: nothing is proposed or owed inside a window',
      ref: null,
      dueAt: null,
    },
  };
}

function consumedTurn(f: ContractFacts, v: StandingViewer, current: VersionFact | null): Turn {
  const change = f.change;
  if (change?.open) {
    const act = `adapt to ${change.version} by ${day(change.dueAt)}`;
    const rule =
      'consumedTurn: the provider approved a breaking version; core filed one item per consumer, open until it is verified or declined';
    return v.acts
      ? {
          group: 'needs_you',
          waitingOn: {
            kind: 'you',
            who: 'You',
            act,
            rule,
            ref: change.feedback,
            dueAt: change.dueAt.toISOString(),
          },
        }
      : {
          group: 'waiting',
          waitingOn: {
            kind: 'person',
            who: 'A project member',
            act,
            rule,
            ref: change.feedback,
            dueAt: change.dueAt.toISOString(),
          },
        };
  }

  const act = !current
    ? 'the provider has published no version'
    : f.ours === current.version
      ? `on the latest, ${current.version}`
      : `built against ${f.ours ?? 'no version'}; ${current.version} is current`;
  return {
    group: 'steady',
    waitingOn: {
      kind: 'none',
      who: 'Nobody',
      act,
      rule: 'consumedTurn: no breaking item is open',
      ref: null,
      dueAt: null,
    },
  };
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
