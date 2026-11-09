// The pairs of outbox events that say one fact (REQ-12 BC-18 r6, ISS-1181): one act yields one
// event per distinct fact it reports, so two events of a pair naming the same subject in one
// transaction are refused `OUTBOX_FACT_TWICE`. Declared here as data, read by the integration
// setup file `outbox-fact-guard.ts`; a sixth pair is one more entry. Acts reporting distinct facts
// (a park and its question, a merge mark and its audit comment, a cut and the tag it owes, an
// answer and the act it decides) are no pair and are never listed.

/** One outbox row as the guard's test-only trigger copied it, grouped by `txid_current()`. */
export interface GuardedEvent {
  txid: string;
  type: string;
  payload: Record<string, unknown>;
}

/** One side of a pair: the types it covers, and the subject each names (null: not this side). */
interface FactSide {
  types: readonly string[];
  subject: (type: string, payload: Record<string, unknown>) => string | null;
}

export interface FactPair {
  key: string;
  /** What the two sides both say, for the refusal's reader. */
  fact: string;
  a: FactSide;
  b: FactSide;
}

const field =
  (name: string) =>
  (_type: string, p: Record<string, unknown>): string | null =>
    typeof p[name] === 'string' ? (p[name] as string) : null;

/** The key a `decision.settled` subject is written in, for each event that also reports a decision. */
function decisionSubjectOf(type: string, p: Record<string, unknown>): string | null {
  if (type === 'requirement.agreed') return field('key')(type, p);
  if (type === 'contract.versionApproved') return `${p.contractSlug}@${p.version}`;
  if (type === 'suggestion.proposed') return field('suggestionId')(type, p);
  return null;
}

/** `issues/work-state.ts:setWorkStep`'s project refresh, as distinct from every other room frame. */
function stepFrameProject(_type: string, p: Record<string, unknown>): string | null {
  const data = p.data as Record<string, unknown> | undefined;
  if (p.event !== 'project.now.changed' || data?.source !== 'step') return null;
  return field('projectId')(_type, p);
}

export const FACT_PAIRS: readonly FactPair[] = [
  {
    key: 'F1',
    fact: "a requirement's move into agreed, accepted or delivered",
    a: { types: ['requirement.transitioned'], subject: field('id') },
    b: {
      types: ['requirement.agreed', 'requirement.accepted', 'requirement.delivered'],
      subject: field('requirementId'),
    },
  },
  {
    key: 'F2',
    fact: "a question's answer",
    a: { types: ['question.transitioned'], subject: field('id') },
    b: { types: ['question.answered'], subject: field('questionId') },
  },
  {
    key: 'F3',
    fact: "a release run's ship",
    a: { types: ['run.transitioned'], subject: field('id') },
    b: { types: ['release.shipped'], subject: field('runId') },
  },
  {
    key: 'F4',
    fact: 'a person’s decision another event already reports',
    a: { types: ['decision.settled'], subject: field('subject') },
    b: {
      types: ['requirement.agreed', 'contract.versionApproved', 'suggestion.proposed'],
      subject: decisionSubjectOf,
    },
  },
  {
    key: 'F5',
    fact: "an issue's move or stamp, refreshed to its project's Now",
    a: { types: ['session.pushed'], subject: stepFrameProject },
    b: { types: ['issue.transitioned', 'issue.updated'], subject: field('projectId') },
  },
];

/** Every `OUTBOX_FACT_TWICE <type-a>+<type-b> <subject>` the events say, one per pair and subject. */
export function factsSaidTwice(
  events: readonly GuardedEvent[],
  pairs: readonly FactPair[] = FACT_PAIRS,
): string[] {
  const byTx = new Map<string, GuardedEvent[]>();
  for (const e of events) byTx.set(e.txid, [...(byTx.get(e.txid) ?? []), e]);
  const said = new Set<string>();
  for (const txEvents of byTx.values()) {
    for (const pair of pairs) {
      const as = sideOf(pair.a, txEvents);
      for (const [subject, typeB] of sideOf(pair.b, txEvents)) {
        const typeA = as.get(subject);
        if (typeA) said.add(`OUTBOX_FACT_TWICE ${typeA}+${typeB} ${subject} (${pair.key})`);
      }
    }
  }
  return [...said];
}

function sideOf(side: FactSide, events: readonly GuardedEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (!side.types.includes(e.type)) continue;
    const subject = side.subject(e.type, e.payload);
    if (subject !== null && !out.has(subject)) out.set(subject, e.type);
  }
  return out;
}
