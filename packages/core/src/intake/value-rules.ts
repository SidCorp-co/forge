/**
 * The value check judged against what the draft read (REQ-65 BC-1..BC-5), with nothing read from the
 * database: each fact names the item, a record it was shown, or a question whose recommended answer it
 * takes; what the item repeats is a duplicate link that stands; a question holds the check only on a
 * missing problem or value, or on a criterion a conflict link quotes, and the check ends exactly when
 * nothing holds it. A feedback item's triage follows how the check ended (REQ-66 BC-2). Each fault is
 * a sentence the model reads on its one retry.
 */

import {
  type IntakeDraftLink,
  type IntakeDraftRef,
  type IntakeItemKind,
  type IntakeQuestion,
  intakeRefOf,
  RECOMMENDED_SOURCE,
  type ValueCheckAnswer,
  type ValueFactView,
  type ValueOutcomeView,
} from '@forge/contracts/intake-drafts';

/** The value check as judged: each fact's source resolved, the outcome null while a question holds it. */
export interface JudgedValue {
  who: ValueFactView | null;
  improves: ValueFactView | null;
  measured: ValueFactView | null;
  exists: { ref: IntakeDraftRef; why: string } | null;
  outcome: ValueOutcomeView | null;
}

export interface ValueContext {
  item: { kind: IntakeItemKind; key: string; title: string };
  /** Every record the draft was shown, by the ref it was shown under. */
  known: ReadonlyMap<string, IntakeDraftRef>;
  links: readonly IntakeDraftLink[];
  questions: readonly IntakeQuestion[];
}

const refOfShown = (r: IntakeDraftRef): IntakeDraftRef => ({
  kind: r.kind,
  key: r.key,
  title: r.title,
});

/** One fact with its source resolved: the item, a record shown, or a non-blocking question's recommended answer. */
function factOf(
  name: string,
  fact: ValueCheckAnswer['who'],
  c: ValueContext,
  faults: string[],
): ValueFactView | null {
  if (!fact) return null;
  const asked = RECOMMENDED_SOURCE.exec(fact.source);
  if (asked) {
    const number = Number(asked[1]);
    const q = c.questions[number - 1];
    if (!q) {
      faults.push(
        `value.${name}.source "${fact.source}" names no question: ${c.questions.length} are asked`,
      );
      return null;
    }
    if (q.blocks !== null) {
      faults.push(
        `value.${name}.source "${fact.source}" is a question that blocks the check: a blocking question's answer is waited for, never assumed`,
      );
      return null;
    }
    const label = q.options.find((o) => o.id === q.recommended)?.label;
    if (!label) return null;
    // the assumption is the recommended answer as offered, whatever words the model put beside it
    return { value: label, source: { kind: 'recommended', question: number } };
  }
  if (fact.source === c.item.key) {
    return {
      value: fact.value,
      source: { kind: c.item.kind, key: c.item.key, title: c.item.title },
    };
  }
  const shown = c.known.get(fact.source);
  if (!shown) {
    faults.push(
      `value.${name}.source "${fact.source}" is not ${c.item.key}, a ref shown in the record, or question:N`,
    );
    return null;
  }
  return { value: fact.value, source: refOfShown(shown) };
}

function outcomeOf(
  answer: ValueCheckAnswer,
  exists: JudgedValue['exists'],
  c: ValueContext,
  faults: string[],
): ValueOutcomeView | null {
  const o = answer.outcome;
  if (!o) return null;
  if (o.kind === 'accept') {
    if (exists) {
      faults.push(
        `value.outcome accepts ${c.item.key}, which repeats ${exists.ref.key}: merge into it, offer a better alternative, or refuse`,
      );
    }
    return { kind: 'accept' };
  }
  if (o.kind === 'merge') {
    if (!exists || intakeRefOf(exists.ref) !== o.into) {
      faults.push(
        `value.outcome merges into ${o.into}, which is not what value.exists names: a merge joins the item it repeats`,
      );
      return null;
    }
    return { kind: 'merge', into: exists.ref, why: o.why };
  }
  if (o.kind === 'alternative') {
    if (o.ref === null) return { kind: 'alternative', instead: o.instead, ref: null };
    const shown = c.known.get(o.ref);
    if (!shown) {
      faults.push(`value.outcome.ref "${o.ref}" is not a ref shown in the record`);
      return null;
    }
    return { kind: 'alternative', instead: o.instead, ref: refOfShown(shown) };
  }
  return { kind: 'refuse', reason: o.reason };
}

/**
 * The value check judged (REQ-65 BC-1..BC-5): a question blocks only on a missing problem or value,
 * or on a criterion a standing conflict link quotes; a missing problem or value is asked or refused;
 * every other gap is filled, from the record or from a question's recommended answer; and the check
 * ends exactly when nothing holds it.
 */
export function judgeValue(
  answer: ValueCheckAnswer,
  c: ValueContext,
): { value: JudgedValue; faults: string[] } {
  const faults: string[] = [];
  const who = factOf('who', answer.who, c, faults);
  const improves = factOf('improves', answer.improves, c, faults);
  const measured = factOf('measured', answer.measured, c, faults);
  let exists: JudgedValue['exists'] = null;
  if (answer.exists) {
    const link = c.links.find(
      (l) => l.relation === 'duplicate' && intakeRefOf(l.ref) === answer.exists?.ref,
    );
    if (link) exists = { ref: link.ref, why: answer.exists.why };
    else {
      faults.push(
        `value.exists names ${answer.exists.ref}, which no duplicate link that stands names: link it as a duplicate with its basis, or set exists to null`,
      );
    }
  }
  const outcome = outcomeOf(answer, exists, c, faults);
  const blocking = c.questions.filter((q) => q.blocks !== null);
  for (const [i, q] of c.questions.entries()) {
    if (q.blocks === 'problem' && answer.who !== null) {
      faults.push(
        `questions[${i}] blocks on the problem, which value.who states: a question blocks only on what is missing`,
      );
    }
    if (q.blocks === 'value' && answer.improves !== null) {
      faults.push(
        `questions[${i}] blocks on the value, which value.improves states: a question blocks only on what is missing`,
      );
    }
    if (
      q.blocks === 'criterion' &&
      !c.links.some((l) => l.relation === 'conflict' && l.basis?.criterion)
    ) {
      faults.push(
        `questions[${i}] blocks on a criterion, but no conflict link that stands quotes one: link the criterion it contradicts, or let it not block`,
      );
    }
  }
  const refused = answer.outcome?.kind === 'refuse';
  if (answer.who === null && !refused && !blocking.some((q) => q.blocks === 'problem')) {
    faults.push(
      'value.who is null: ask whose problem it is in a question that blocks on "problem", or refuse the request for naming nobody',
    );
  }
  if (answer.improves === null && !refused && !blocking.some((q) => q.blocks === 'value')) {
    faults.push(
      'value.improves is null: ask what improves in a question that blocks on "value", or refuse the request for giving nothing',
    );
  }
  if (answer.measured === null) {
    faults.push(
      'value.measured is null, a gap that does not block: fill it from the record, or ask a question and name it as the source (question:N) so its recommended answer is taken',
    );
  }
  if (blocking.length > 0 && answer.outcome !== null) {
    faults.push('a question blocks the check, so value.outcome is null until it is answered');
  }
  if (blocking.length === 0 && answer.outcome === null) {
    faults.push(
      'value.outcome is null while no question blocks: end the check as accept, merge, alternative or refuse',
    );
  }
  return { value: { who, improves, measured, exists, outcome }, faults };
}

/** A feedback item's triage follows how its value check ended (REQ-66 BC-2). */
export function triageFollowsFaults(triage: unknown, outcome: ValueOutcomeView): string[] {
  const t = (typeof triage === 'object' && triage !== null ? triage : {}) as {
    route?: unknown;
    duplicateOf?: unknown;
  };
  if (outcome.kind === 'refuse' && t.route !== 'decline') {
    return ['value.outcome refuses the item, so triage.route is "decline", its note the reason'];
  }
  if (outcome.kind === 'merge') {
    const into = intakeRefOf(outcome.into);
    if (t.route !== 'duplicate' || t.duplicateOf !== into) {
      return [
        `value.outcome merges into ${into}, so triage.route is "duplicate" with duplicateOf ${into}`,
      ];
    }
  }
  if (
    (outcome.kind === 'accept' || outcome.kind === 'alternative') &&
    (t.route === 'decline' || t.route === 'duplicate')
  ) {
    return [
      `value.outcome is ${outcome.kind}, so triage neither declines nor routes as a duplicate`,
    ];
  }
  return [];
}
