/**
 * The kinds this CLI layer defines, and the sections each kind's body owes.
 *
 * `forge new` reads a body against this table at a terminal and refuses what does not carry it.
 * Nothing arriving through the tracker's own tool could reach any of it, so an agent filing there
 * was held to a thinner bar than a person typing (ISS-985). This is the server-side half.
 */

export type SectionShape = {
  readonly title: string;
  readonly reads: string;
  readonly bare: string;
  readonly wants: string;
  readonly heading: RegExp;
  readonly spoken: RegExp | null;
  readonly substantial: boolean;
  readonly add: string;
};

export const SUBSTANTIAL_WORDS = 4;

const LINE = `and under it one line of ${SUBSTANTIAL_WORDS} words or more`;

function section(
  one: Omit<SectionShape, 'add' | 'spoken' | 'substantial'> &
    Partial<Pick<SectionShape, 'spoken' | 'substantial'>>,
): SectionShape {
  return { spoken: null, substantial: true, ...one, add: `## ${one.title}` };
}

export const OUTCOME = section({
  title: 'Outcome',
  reads: 'the outcome',
  bare: 'outcome',
  wants: `a heading naming the outcome, ${LINE} saying what is true after the change`,
  heading: /\boutcome\b/iu,
});

export const RULES = section({
  title: 'Rules',
  reads: 'rules, invariants or acceptance',
  bare: 'rule',
  wants: `a heading of rules, invariants or acceptance, ${LINE}`,
  heading: /\b(?:rules?|invariants?|acceptance|behaviours?)\b/iu,
});

// cm:why `spoken` and `substantial: false` are this section's alone — refusing "nothing is out of scope" would teach a filer to satisfy the gate with an empty heading, which reads later as a scope nobody decided
export const SCOPE = section({
  title: 'Out of scope',
  reads: 'the out-of-scope',
  bare: 'out-of-scope',
  wants: 'an out-of-scope heading, or one line saying nothing is out of scope',
  heading: /\bout[\s-]of[\s-]scope\b/iu,
  spoken: /\bnothing\b[^.\n]{0,60}\bout[\s-]of[\s-]scope\b/iu,
  substantial: false,
});

export const HAPPENED = section({
  title: 'What happened',
  reads: 'what happened',
  bare: 'what-happened',
  wants: `a heading saying what happened, ${LINE} naming the failure a reader has to reproduce`,
  heading: /\bwhat happened\b|\bwhat went wrong\b|\bwhat broke\b/iu,
});

export const CAUSE = section({
  title: 'Why it happens',
  reads: 'why it happens',
  bare: 'cause',
  wants:
    `a heading naming the cause, ${LINE} giving the line, verb or clause the symptom comes from` +
    ', or saying none was found and what was looked at',
  heading: /\bwhy (?:it|this) happens\b|\b(?:root )?causes?\b|\bwhere it comes from\b/iu,
});

export const TODAY = section({
  title: 'What happens today',
  reads: 'what happens today',
  bare: 'what-happens-today',
  wants: `a heading saying what happens today, ${LINE} describing the behaviour being replaced`,
  heading: /\btoday\b|\b(?:it|there) is now\b|\bit does now\b|\bcurrently\b/iu,
});

export const WHERE = section({
  title: 'Where',
  reads: 'where',
  bare: 'where',
  wants: 'the file, the verb or the screen it happens on',
  heading: /\bwhere\b/iu,
});

export const WHY = section({
  title: 'Why',
  reads: 'why',
  bare: 'why',
  wants: 'what makes it worth a round of the flow',
  heading: /\bwhy\b/iu,
});

export type KindShape = {
  readonly kind: string;
  readonly is: string;
  readonly needs: readonly SectionShape[];
  readonly says: readonly SectionShape[];
};

// cm:hack ISS-1267 until:`forge new` reads the kinds and the sections off this table over the wire — `plugin/src/tracker/issue-shape.mjs` in github.com/SidCorp-co/forge-plugin holds a second copy of everything below, so a kind or a section added here without the same edit there leaves the terminal door and the tool door refusing different bodies (ISS-1267 is on the forge-plugin project)
export const KINDS: readonly KindShape[] = [
  {
    kind: 'bug',
    is: 'something that worked, or was meant to, and does not',
    needs: [HAPPENED, CAUSE, OUTCOME, RULES, SCOPE],
    says: [WHERE],
  },
  {
    kind: 'enhancement',
    is: 'something that works, and should work better',
    needs: [TODAY, OUTCOME, RULES, SCOPE],
    says: [WHY],
  },
  {
    kind: 'feature',
    is: 'something that is not there at all',
    needs: [OUTCOME, RULES, SCOPE],
    says: [WHY],
  },
  {
    kind: 'review',
    is: 'a reading of work already landed, whose outcome is findings landed or filed and a mark moved',
    needs: [OUTCOME, RULES, SCOPE],
    says: [WHY],
  },
];

export const KIND_NAMES: readonly string[] = KINDS.map((one) => one.kind);

export function shapeFor(kind: string): KindShape | null {
  return KINDS.find((one) => one.kind === kind) ?? null;
}

const VOWEL = /^[aeiou]/iu;

export function article(word: string): string {
  return VOWEL.test(word) ? 'an' : 'a';
}

const KIND_ROUTE =
  'a filing needing another category, or another section under one, files an issue' +
  ' against this plugin rather than inventing the value';

export const KIND_WANTS = `one of ${KIND_NAMES.join(', ')} — ${KIND_ROUTE}`;

/** A category outside the four: the section list nobody has decided is not one to guess at. */
export function kindRefusal(given: string): string {
  return (
    `\`${given}\` is not a category this CLI layer defines. They are ${KIND_NAMES.join(', ')}.` +
    `\nIt names no shape to read the body against, and ${KIND_ROUTE}.`
  );
}

/** A filing that named none at all: prose decides neither the sections nor the tracker's field. */
export function kindNeeded(): string {
  return (
    'A filing needs a category. It decides which sections the body is read against and it is the' +
    " tracker's own field for it, so a filing without one is read against a guess and stored" +
    ` against nothing.\nName one of ${KIND_NAMES.join(', ')} — ${KIND_ROUTE}.`
  );
}
