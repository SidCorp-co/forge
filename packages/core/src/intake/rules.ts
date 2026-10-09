/**
 * The intake draft judged against what it read (REQ-34 BC-12..BC-16), with nothing read from the
 * database: a link names a record the draft was shown, of a kind its relation takes; an assumption
 * names the item itself or such a record as its source and fills a field the item has; at most three
 * questions, each with a recommended option it offers; and a nothing-to-ask line exactly when it
 * asks nothing. Each fault is a sentence the model reads on its one retry.
 */

import {
  INTAKE_FIELDS,
  INTAKE_LINK_TARGETS,
  type IntakeAnswer,
  type IntakeDraftAssumption,
  type IntakeDraftLink,
  type IntakeDraftRef,
  type IntakeField,
  type IntakeItemKind,
  type IntakeQuestion,
} from '@forge/contracts/intake-drafts';

export interface JudgedDraft {
  links: IntakeDraftLink[];
  assumptions: IntakeDraftAssumption[];
  questions: IntakeQuestion[];
  nothingToAsk: string | null;
  /** A feedback draft's triage checklist, parsed by the suggestion's own schema. */
  triage: unknown;
}

export type Judged = { ok: true; draft: JudgedDraft } | { ok: false; faults: string[] };

export interface JudgeInput {
  item: { kind: IntakeItemKind; key: string; title: string };
  /** Every record the draft was shown, by the ref it was shown under. */
  known: ReadonlyMap<string, IntakeDraftRef>;
  /** A feedback draft's triage checked by the suggestion payload's schema: null when it parses. */
  triageFault: (triage: unknown) => string | null;
}

const fieldsOf = (kind: IntakeItemKind): readonly string[] => INTAKE_FIELDS[kind];

export function judgeDraft(answer: IntakeAnswer, input: JudgeInput): Judged {
  const { item, known } = input;
  const faults: string[] = [];
  const self: IntakeDraftRef = { kind: item.kind, key: item.key, title: item.title };
  const fields = fieldsOf(item.kind);

  const assumptions: IntakeDraftAssumption[] = [];
  for (const [i, f] of answer.fills.entries()) {
    if (!fields.includes(f.field)) {
      faults.push(`fills[${i}].field "${f.field}" is not one of ${fields.join(', ')}`);
      continue;
    }
    const source = f.source === item.key ? self : known.get(f.source);
    if (!source) {
      faults.push(
        `fills[${i}].source "${f.source}" is not ${item.key} or a ref shown in the record`,
      );
      continue;
    }
    assumptions.push({ field: f.field as IntakeField, value: f.value, source });
  }

  const links: IntakeDraftLink[] = [];
  const seen = new Set<string>();
  for (const [i, l] of answer.links.entries()) {
    const ref = known.get(l.ref);
    if (l.ref === item.key) {
      faults.push(`links[${i}] links ${item.key} to itself`);
      continue;
    }
    if (!ref) {
      faults.push(`links[${i}].ref "${l.ref}" is not a ref shown in the record`);
      continue;
    }
    const takes = INTAKE_LINK_TARGETS[l.relation];
    if (!takes.includes(ref.kind) || (l.relation === 'duplicate' && ref.kind !== item.kind)) {
      const want = l.relation === 'duplicate' ? item.kind : takes.join(' or ');
      faults.push(
        `links[${i}] names ${ref.kind} ${l.ref} as ${l.relation}, which links only: ${want}`,
      );
      continue;
    }
    const twin = `${l.relation} ${l.ref}`;
    if (seen.has(twin)) continue;
    seen.add(twin);
    links.push({ relation: l.relation, ref, why: l.why });
  }

  for (const [i, q] of answer.questions.entries()) {
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) faults.push(`questions[${i}] offers one option id twice`);
    if (!ids.includes(q.recommended)) {
      faults.push(
        `questions[${i}].recommended "${q.recommended}" is not one of its options (${ids.join(', ')})`,
      );
    }
  }
  const asks = answer.questions.length > 0;
  if (asks && answer.nothingToAsk !== null) {
    faults.push('nothingToAsk is set while questions are asked: set it to null');
  }
  if (!asks && answer.nothingToAsk === null) {
    faults.push(
      'no question is asked and nothingToAsk is null: say in one line that nothing is worth asking',
    );
  }

  if (item.kind === 'feedback') {
    if (answer.triage === undefined) {
      faults.push('triage is missing: a feedback draft carries its triage checklist');
    } else {
      const wrong = input.triageFault(answer.triage);
      if (wrong) faults.push(`triage: ${wrong}`);
    }
  } else if (answer.triage !== undefined) {
    faults.push('triage is set on a requirement draft: leave it out');
  }

  if (faults.length) return { ok: false, faults };
  return {
    ok: true,
    draft: {
      links,
      assumptions,
      questions: answer.questions,
      nothingToAsk: asks ? null : answer.nothingToAsk,
      triage: answer.triage,
    },
  };
}
