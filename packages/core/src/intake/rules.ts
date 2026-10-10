/**
 * The intake draft judged against what it read (REQ-34 BC-12..BC-16), with nothing read from the
 * database: a link names a record the draft was shown, of a kind its relation takes, and carries its
 * basis quoted word for word from what was shown — the item's own words it rests on, and the linked
 * record's: the criterion a conflict contradicts, the step an affected workflow changes, the words a
 * duplicate or related item shares. A workflow the item's words touch is linked or set aside with
 * why; a proposed decline or duplicate rests only on a link that stands. An assumption names the item
 * itself or such a record as its source and fills a field the item has; at most three questions, each
 * with a recommended option it offers; and a nothing-to-ask line exactly when it asks nothing. Each
 * fault is a sentence the model reads on its one retry.
 */

import {
  INTAKE_FIELDS,
  INTAKE_LINK_TARGETS,
  type IntakeAnswer,
  type IntakeDraftAssumption,
  type IntakeDraftLink,
  type IntakeDraftRef,
  type IntakeDraftUnaffected,
  type IntakeField,
  type IntakeItemKind,
  type IntakeLinkBasis,
  type IntakeQuestion,
  intakeRefOf,
} from '@forge/contracts/intake-drafts';

export interface JudgedDraft {
  links: IntakeDraftLink[];
  notAffected: IntakeDraftUnaffected[];
  assumptions: IntakeDraftAssumption[];
  questions: IntakeQuestion[];
  nothingToAsk: string | null;
  /** A feedback draft's triage checklist, parsed by the suggestion's own schema. */
  triage: unknown;
}

export type Judged = { ok: true; draft: JudgedDraft } | { ok: false; faults: string[] };

/** One record as the draft was shown it: what a link's basis must quote. */
export interface ShownRecord extends IntakeDraftRef {
  lines: readonly string[];
  /** A requirement's criteria, as shown. */
  criteria?: readonly { code: string; text: string }[];
  /** A workflow's step labels, as shown. */
  steps?: readonly string[];
}

export interface JudgeInput {
  item: { kind: IntakeItemKind; key: string; title: string; lines: readonly string[] };
  /** Every record the draft was shown, by the ref it was shown under. */
  known: ReadonlyMap<string, ShownRecord>;
  /** Workflows the item's words touch (`workflowsTouched`): each linked as affected, or set aside with why. */
  touched?: readonly string[];
  /** A feedback draft's triage checked by the suggestion payload's schema: null when it parses. */
  triageFault: (triage: unknown) => string | null;
}

/** A quote shorter than this cannot carry a basis: "the", "a bug" match anything. */
const QUOTE_WORDS_MIN = 3;
/** Workflows offered as touched, the most words in common first. */
const TOUCHED_MAX = 4;

const fieldsOf = (kind: IntakeItemKind): readonly string[] => INTAKE_FIELDS[kind];

/** Text as compared for a quote: case, quotation marks, an ellipsis and runs of space do not count. */
const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[“”"‘’`]/g, '')
    .replace(/…/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?'-]+|[\s.,;:!?'-]+$/g, '')
    .trim();

const wordCount = (text: string) => norm(text).split(' ').filter(Boolean).length;

/** Whether `quote` stands word for word in `text`, as compared. */
const quotedIn = (quote: string, text: string) => {
  const q = norm(quote);
  return q !== '' && norm(text).includes(q);
};

const clipped = (text: string) => (text.length <= 80 ? text : `${text.slice(0, 79)}…`);

/** The item's own words: its lines, but the kind and target core wrote beside them. */
const ownLines = (lines: readonly string[]) =>
  lines.filter((l) => !/^(Kind given|About):/.test(l.trim()));

/** Refs a triage's free text names: REQ-n, FB-n, workflow:<flow>. */
const refsIn = (text: string) => [
  ...new Set(
    [...text.matchAll(/\b(?:REQ|FB)-[1-9][0-9]*\b|\bworkflow:[A-Za-z0-9_-]+/g)].map((m) => m[0]),
  ),
];

// words a workflow's title shares with almost any item, and so name no subject of it
const GENERIC = new Set([
  'flow',
  'lifecycle',
  'view',
  'core',
  'with',
  'from',
  'into',
  'what',
  'they',
  'their',
  'when',
  'around',
  'components',
  'context',
  'derived',
  'produced',
]);

/** A word's stem as compared: the first five letters of a longer word, a four-letter word whole. */
const stemsOf = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
      .filter((w) => !GENERIC.has(w))
      .map((w) => w.slice(0, 5)),
  );

/**
 * The workflows whose subject the item's words touch: the one it was filed against, then those whose
 * title shares a word with the item's own words (`triaging` touches "Feedback triage"), the most words
 * in common first. Core offers these so the draft names each, or says why it is not affected, rather
 * than leaving every workflow link to the model.
 */
export function workflowsTouched(
  item: { lines: readonly string[]; workflowRef?: string },
  workflows: readonly { ref: string; title: string }[],
): string[] {
  const said = stemsOf(ownLines(item.lines).join(' '));
  const scored = workflows
    .map((w) => ({ ref: w.ref, shared: [...stemsOf(w.title)].filter((s) => said.has(s)).length }))
    .filter((w) => w.shared > 0 && w.ref !== item.workflowRef)
    .sort((a, b) => b.shared - a.shared);
  const own = item.workflowRef && workflows.some((w) => w.ref === item.workflowRef);
  return [...(own ? [item.workflowRef as string] : []), ...scored.map((w) => w.ref)].slice(
    0,
    TOUCHED_MAX,
  );
}

type LinkAnswer = IntakeAnswer['links'][number];

/** The basis a link carries, judged against the record it names and the item; a fault where it is not in what was read. */
function basisOf(
  i: number,
  l: LinkAnswer,
  ref: ShownRecord,
  item: JudgeInput['item'],
): { basis: IntakeLinkBasis } | { fault: string } {
  const own = ownLines(item.lines);
  if (
    wordCount(l.itemQuote) < QUOTE_WORDS_MIN ||
    !own.some((line) => quotedIn(l.itemQuote, line))
  ) {
    return {
      fault: `links[${i}].itemQuote "${clipped(l.itemQuote)}" is not ${item.key}'s own words: quote at least ${QUOTE_WORDS_MIN} words the item says that the ${l.relation} rests on`,
    };
  }
  const quoted = { quote: l.basis, itemQuote: l.itemQuote };
  if (l.relation === 'conflict') {
    const criterion =
      wordCount(l.basis) >= QUOTE_WORDS_MIN
        ? ref.criteria?.find((c) => quotedIn(l.basis, c.text))
        : undefined;
    if (!criterion) {
      return {
        fault: `links[${i}] conflicts with ${l.ref} on "${clipped(l.basis)}", which is no criterion of ${l.ref} as shown: quote the criterion it contradicts`,
      };
    }
    const other = [...new Set(l.why.match(/\bBC-[1-9][0-9]*\b/g) ?? [])].filter(
      (code) => code !== criterion.code,
    );
    if (other.length) {
      return {
        fault: `links[${i}].why names ${other.join(', ')}, but the criterion it quotes is ${l.ref} ${criterion.code}: a conflict rests on the criterion it quotes`,
      };
    }
    return { basis: { ...quoted, criterion: criterion.code } };
  }
  if (l.relation === 'affected_workflow') {
    const step = ref.steps?.find(
      (s) =>
        norm(s) === norm(l.basis) ||
        (wordCount(l.basis) >= QUOTE_WORDS_MIN && quotedIn(l.basis, s)),
    );
    if (!step) {
      return {
        fault: `links[${i}] names "${clipped(l.basis)}" of ${l.ref}, which is no step of it as shown: name the step the item changes`,
      };
    }
    return { basis: { ...quoted, step } };
  }
  if (wordCount(l.basis) < QUOTE_WORDS_MIN || !ref.lines.some((line) => quotedIn(l.basis, line))) {
    return {
      fault: `links[${i}].basis "${clipped(l.basis)}" is not ${l.ref}'s words as shown: quote at least ${QUOTE_WORDS_MIN} words of it that ${item.key} shares`,
    };
  }
  return { basis: quoted };
}

/** A proposed decline or duplicate rests only on a link that stands; a refused link carries nothing. */
function triageRestFaults(
  triage: unknown,
  standing: readonly IntakeDraftLink[],
  refused: ReadonlySet<string>,
): string[] {
  if (typeof triage !== 'object' || triage === null || Array.isArray(triage)) return [];
  const t = triage as { route?: unknown; note?: unknown; duplicateOf?: unknown };
  const stands = new Set(standing.map((l) => intakeRefOf(l.ref)));
  const why = (ref: string) => (refused.has(ref) ? ` (its link was refused)` : '');
  if (t.route === 'decline' && typeof t.note === 'string') {
    return refsIn(t.note)
      .filter((ref) => !stands.has(ref))
      .map(
        (ref) =>
          `triage declines citing ${ref}, which no link that stands names${why(ref)}: decline only on a link that holds`,
      );
  }
  if (t.route === 'duplicate' && typeof t.duplicateOf === 'string') {
    const root = t.duplicateOf;
    const held = standing.some((l) => l.relation === 'duplicate' && intakeRefOf(l.ref) === root);
    return held
      ? []
      : [
          `triage routes as a duplicate of ${root}, which no duplicate link that stands names${why(root)}: link it as a duplicate with its basis, or route otherwise`,
        ];
  }
  return [];
}

export function judgeDraft(answer: IntakeAnswer, input: JudgeInput): Judged {
  const { item, known } = input;
  const faults: string[] = [];
  const self: IntakeDraftRef = { kind: item.kind, key: item.key, title: item.title };
  const fields = fieldsOf(item.kind);
  const refOf = (r: ShownRecord): IntakeDraftRef => ({ kind: r.kind, key: r.key, title: r.title });

  const assumptions: IntakeDraftAssumption[] = [];
  for (const [i, f] of answer.fills.entries()) {
    if (!fields.includes(f.field)) {
      faults.push(`fills[${i}].field "${f.field}" is not one of ${fields.join(', ')}`);
      continue;
    }
    const shown = known.get(f.source);
    const source = f.source === item.key ? self : shown ? refOf(shown) : undefined;
    if (!source) {
      faults.push(
        `fills[${i}].source "${f.source}" is not ${item.key} or a ref shown in the record`,
      );
      continue;
    }
    assumptions.push({ field: f.field as IntakeField, value: f.value, source });
  }

  const links: IntakeDraftLink[] = [];
  const refused = new Set<string>();
  const seen = new Set<string>();
  for (const [i, l] of answer.links.entries()) {
    const ref = known.get(l.ref);
    if (l.ref === item.key) {
      faults.push(`links[${i}] links ${item.key} to itself`);
      continue;
    }
    if (!ref) {
      faults.push(`links[${i}].ref "${l.ref}" is not a ref shown in the record`);
      refused.add(l.ref);
      continue;
    }
    const takes = INTAKE_LINK_TARGETS[l.relation];
    if (!takes.includes(ref.kind) || (l.relation === 'duplicate' && ref.kind !== item.kind)) {
      const want = l.relation === 'duplicate' ? item.kind : takes.join(' or ');
      faults.push(
        `links[${i}] names ${ref.kind} ${l.ref} as ${l.relation}, which links only: ${want}`,
      );
      refused.add(l.ref);
      continue;
    }
    const based = basisOf(i, l, ref, item);
    if ('fault' in based) {
      faults.push(based.fault);
      refused.add(l.ref);
      continue;
    }
    const twin = `${l.relation} ${l.ref}`;
    if (seen.has(twin)) continue;
    seen.add(twin);
    links.push({ relation: l.relation, ref: refOf(ref), why: l.why, basis: based.basis });
  }

  const notAffected: IntakeDraftUnaffected[] = [];
  for (const [i, n] of answer.notAffected.entries()) {
    const ref = known.get(n.ref);
    if (ref?.kind !== 'workflow') {
      faults.push(`notAffected[${i}].ref "${n.ref}" is not a workflow shown in the record`);
      continue;
    }
    notAffected.push({ ref: refOf(ref), why: n.why });
  }
  for (const ref of input.touched ?? []) {
    if (refused.has(ref)) continue;
    const linked = links.some(
      (l) => l.relation === 'affected_workflow' && intakeRefOf(l.ref) === ref,
    );
    const aside = notAffected.some((n) => intakeRefOf(n.ref) === ref);
    if (!linked && !aside) {
      faults.push(
        `${ref} is a workflow ${item.key}'s words touch: link it as affected_workflow with the step it changes, or say in notAffected why it is not affected`,
      );
    }
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
      faults.push(...triageRestFaults(answer.triage, links, refused));
    }
  } else if (answer.triage !== undefined) {
    faults.push('triage is set on a requirement draft: leave it out');
  }

  if (faults.length) return { ok: false, faults };
  return {
    ok: true,
    draft: {
      links,
      notAffected,
      assumptions,
      questions: answer.questions,
      nothingToAsk: asks ? null : answer.nothingToAsk,
      triage: answer.triage,
    },
  };
}
