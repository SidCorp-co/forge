/**
 * ISS-1041 — the read forms the model repeats on every turn, carried in the
 * `forge` tool's description so a question costs no `-h` round, and held to the
 * bundled CLI's own help by `forge-cli-forms.test.ts` so the two cannot disagree.
 */

export interface CliForm {
  /** The argv after `forge`; `<…>` marks an operand the model fills. */
  readonly argv: readonly string[];
  /** What it answers, for the description. */
  readonly says: string;
}

// cm:guard hand-carried and held to `-h` by a test that validates the WHOLE form — flags, their operands and the positionals — rather than generated at boot: a spawn in the request path to produce 200 characters is a moving part, and the test fails on the same drift the generation would have hidden (ISS-1041 D2, codex F3).
export const READ_FORMS: readonly CliForm[] = [
  { argv: ['issue', '--status', '<s>', '--limit', '<n>'], says: 'issues at a status' },
  { argv: ['issue', 'ISS-<n>'], says: 'one issue with its edges and its documentId' },
  { argv: ['issue', '--search', '<q>'], says: 'issues matching text' },
  { argv: ['guide', '<slug>'], says: 'the method for a topic' },
  // cm:guard the WRITE forms are carried too, and the name `READ_FORMS` is kept because every
  // caller and the whole-form test read it: ISS-1041 carried only reads and beta still paid
  // `forge new -h` 3 times and `forge issue -h` 15 times in 146 turns, because a verb whose form
  // is absent is a verb the model asks about (ISS-1057).
  { argv: ['new', '-', '--title', '<t>', '--category', '<c>'], says: 'file an issue' },
  { argv: ['comment', 'ISS-<n>', '-'], says: 'comment on one' },
];

/** One line for the tool description. */
export function readFormsLine(): string {
  const forms = READ_FORMS.map((f) => `\`${f.argv.join(' ')}\` (${f.says})`).join(', ');
  return `Read forms that need no -h: ${forms}.`;
}

/** One positional slot of a Usage line: required outside brackets, optional inside; a literal is a word the caller must type as it stands. */
export interface UsagePositional {
  readonly required: boolean;
  /** The word itself for a literal subcommand (`show`), null for a placeholder (`<uuid>`). */
  readonly literal: string | null;
}

/** A Usage line, read as the options it names (with whether each takes an operand) and the positional slots before them, in order. */
export interface UsageShape {
  readonly options: ReadonlyMap<string, boolean>;
  readonly positionals: readonly UsagePositional[];
}

// cm:guard positionals keep their ORDER, whether they are required, and their literal word: an upper bound on the count let `issue ISS-<n>` pass a Usage line that had grown a required `show` subcommand (codex F2). A bracketed group holding alternatives (`[contract [part]|<skill> [reference]|slug]`) is ONE optional slot the caller fills with any of them, so it carries no literal.
/** `Usage: forge issue [<uuid|ISS-45>] [--status s] …` → its shape. */
export function parseUsage(line: string): UsageShape {
  const after = line.replace(/^\s*Usage:\s*forge\s+\S+\s*/, '');
  const options = new Map<string, boolean>();
  const positionals: UsagePositional[] = [];
  const groups = topLevelGroups(after);
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g] as string;
    const optional = group.startsWith('[');
    const inner = optional ? group.slice(1, -1) : group;
    if (inner.startsWith('--')) {
      const [flags, inlineOperand] = inner.split(/\s+/, 2);
      // cm:guard a REQUIRED flag's operand is its own top-level group and has to be read as one:
      // `[--status s]` brackets the pair, but `forge new … --title T --category C` does not, so a
      // parser reading only the bracketed form called `--title` operandless and then counted `T` as
      // a positional. That made a correct carried form fail and — the direction that matters — would
      // have let a form drop a required operand and still pass (found by ISS-1057 carrying `new`).
      const next = groups[g + 1];
      const takesNext =
        inlineOperand === undefined &&
        !optional &&
        next !== undefined &&
        !next.startsWith('[') &&
        !next.startsWith('--');
      if (takesNext) g++;
      const operand = inlineOperand ?? (takesNext ? next : undefined);
      for (const flag of (flags as string).split('|')) options.set(flag, operand !== undefined);
      continue;
    }
    // cm:why a positional AFTER an option group still counts: a Usage line that grows a required operand at its tail is drift the carried form must fail on (codex F2 of the merged-head read).
    if (inner.includes('|')) {
      positionals.push({ required: !optional, literal: null });
      continue;
    }
    for (const word of inner.replace(/[[\]]/g, ' ').split(/\s+/).filter(Boolean)) {
      positionals.push({
        required: !optional,
        literal: /^[a-z][\w-]*$/.test(word) ? word : null,
      });
    }
  }
  return { options, positionals };
}

/** Split a Usage tail into its top-level tokens: a bare word, or one `[…]` group with its nesting intact. */
function topLevelGroups(text: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '[') depth++;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) groups.push(current);
      current = '';
      continue;
    }
    current += ch;
    if (ch === ']') depth--;
  }
  if (current) groups.push(current);
  return groups;
}

/** Why a carried form does not fit the Usage line; empty when it does. */
export function formProblems(form: CliForm, usage: UsageShape): string[] {
  const problems: string[] = [];
  const [, ...rest] = form.argv;
  let positionals = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string;
    if (t.startsWith('--')) {
      const takes = usage.options.get(t);
      const next = rest[i + 1];
      const operand = next !== undefined && !next.startsWith('--');
      if (takes === undefined) problems.push(`${t} is not in the Usage line`);
      else if (operand !== takes)
        problems.push(`${t} ${takes ? 'takes an operand' : 'takes none'} in the Usage line`);
      if (operand) i++;
    } else {
      positionals++;
    }
  }
  const carried = rest.filter(
    (t, i) =>
      !t.startsWith('--') &&
      !(
        i > 0 &&
        (rest[i - 1] as string).startsWith('--') &&
        usage.options.get(rest[i - 1] as string)
      ),
  );
  usage.positionals.forEach((slot, i) => {
    const got = carried[i];
    if (slot.required && got === undefined) {
      problems.push(`required positional ${slot.literal ?? `#${i + 1}`} is not carried`);
    } else if (slot.literal !== null && got !== undefined && got !== slot.literal) {
      problems.push(`positional #${i + 1} must be the word \`${slot.literal}\`, not \`${got}\``);
    }
  });
  if (positionals > usage.positionals.length)
    problems.push(
      `${positionals} positional(s) carried, Usage line takes ${usage.positionals.length}`,
    );
  return problems;
}
