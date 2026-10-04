/**
 * ISS-1041 — the read forms the model repeats on every turn, carried in the
 * `forge` tool's description so a question costs no `-h` round.
 */

export interface CliForm {
  /** The argv after `forge`; `<…>` marks an operand the model fills. */
  readonly argv: readonly string[];
  /** What it answers, for the description. */
  readonly says: string;
}

const READ_FORMS: readonly CliForm[] = [
  { argv: ['issue', '--status', '<s>', '--limit', '<n>'], says: 'issues at a status' },
  { argv: ['issue', 'ISS-<n>'], says: 'one issue with its edges and its documentId' },
  { argv: ['issue', '--search', '<q>'], says: 'issues matching text' },
  { argv: ['guide', '<slug>'], says: 'the method for a topic' },
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
