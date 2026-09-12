/**
 * What a filing has to carry before the flow can carry it: the kinds this
 * layer defines and the sections each one's body owes, stated once here.
 *
 * One table, because the door that files an issue and the reader that refuses
 * one have to answer for the same body, and a set of sections held apart from
 * the reader of them is two places to correct. The tracker's own schema is
 * copied nowhere below: no status, priority or complexity is named here.
 */

// cm:hack ISS-1267 until:`forge new` reads these kinds and sections off this table instead of its own — the same rules live twice while it does not, here and in `plugin/src/tracker/issue-shape.mjs` in github.com/SidCorp-co/forge-plugin, so a kind or a section added to one and not the other is a divergence nothing reports; the two repos ship on different clocks and this one may not edit that one (CLAUDE.md, the forge-plugin carve-out), which is why the price is declared rather than discovered
export interface CliSection {
  /** The heading a body adds, and the name a refusal calls the section by. */
  readonly title: string;
  /** How a refusal says what it looked for. */
  readonly reads: string;
  /** The noun a refusal takes an article in front of. */
  readonly bare: string;
  /** What the shape wants under the heading. */
  readonly wants: string;
  /** The heading FAMILY this section is matched by, never that one wording. */
  readonly heading: RegExp;
  /** The one sentence a body may carry instead of the section itself. */
  readonly spoken: RegExp | null;
  /** Whether the text under the heading must reach the substantial floor. */
  readonly substantial: boolean;
}

/** Words a line needs before it counts as saying anything. */
export const SUBSTANTIAL = 4;

const LINE = `and under it one line of ${SUBSTANTIAL} words or more`;

function section(
  parts: Omit<CliSection, 'spoken' | 'substantial'> & Partial<Pick<CliSection, 'spoken' | 'substantial'>>,
): CliSection {
  return { spoken: null, substantial: true, ...parts };
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

// cm:guard the one section a sentence may carry INSTEAD of a heading, which is what `spoken` is for and why `substantial` is false here — refusing "nothing is out of scope" would teach a filer to add an empty heading, and an empty heading is what every other section's floor exists to refuse
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

export interface CliKind {
  readonly kind: string;
  readonly is: string;
  /** Missing is refused, by name. */
  readonly needs: readonly CliSection[];
  /** Missing is said in a line and filed. */
  readonly says: readonly CliSection[];
}

export const KINDS: readonly CliKind[] = [
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

export function shapeFor(kind: string): CliKind | null {
  return KINDS.find((one) => one.kind === kind) ?? null;
}

const VOWEL = /^[aeiou]/iu;

export function article(word: string): string {
  return VOWEL.test(word) ? 'an' : 'a';
}

export function listed(names: readonly string[]): string {
  return names.join(', ');
}

function bare(name: string): string {
  return name.replace(/[._\- ]/gu, '').toLowerCase();
}

function distance(left: string, right: string): number {
  let previous = [...Array(right.length + 1).keys()];
  for (let index = 1; index <= left.length; index += 1) {
    const row = [index];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[index - 1] === right[column - 1] ? 0 : 1;
      row[column] = Math.min(
        (row[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    previous = row;
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

/** Zero means the stripped forms match, so a separator-only difference sorts first. */
function rank(given: string, candidate: string): number {
  const left = bare(given);
  const right = bare(candidate);
  if (left === right) return 0;
  if (right.includes(left) || left.includes(right)) return 1;
  const gap = distance(left, right);
  return gap <= Math.max(2, Math.floor(left.length / 3)) ? 1 + gap : Number.POSITIVE_INFINITY;
}

/** What was given, and the nearest names to it. An agent recalls a name from the wrong SHAPE, not from the set. */
export function didYouMean(what: string, given: string, candidates: readonly string[]): string {
  const close = candidates
    .map((candidate) => ({ candidate, points: rank(given, candidate) }))
    .filter((scored) => Number.isFinite(scored.points))
    .sort((one, other) => one.points - other.points)
    .slice(0, 5)
    .map((scored) => scored.candidate);
  const nearest = close.length ? ` Did you mean: ${listed(close)}?` : '';
  return `No ${what} named ${given}.${nearest} The set is ${listed(candidates)}.`;
}

// cm:guard the route past the set is NOT "pick the nearest and carry on" — a kind this layer does not define is a section list nobody has decided, so the way out is an issue against the plugin that owns the table, never a filing fixed by guessing
const KIND_ROUTE =
  'a filing needing another category, or another section under one, files an issue against' +
  ' the plugin rather than inventing the value';

export function kindRefusal(given: string): string {
  return (
    `${didYouMean('category', given, KIND_NAMES)}\nIt names no shape to read the body against,` +
    ` and ${KIND_ROUTE}.`
  );
}

/** A filing that named none at all: prose decides neither the sections nor the field, the same headings carrying a bug and a feature. */
export function kindNeeded(): string {
  return (
    'A filing needs a category. It decides which sections the body is read against and it is' +
    " the tracker's own field for it, so a filing without one is read against a guess and" +
    ` stored against nothing.\nName one of ${listed(KIND_NAMES)} — ${KIND_ROUTE}.`
  );
}
