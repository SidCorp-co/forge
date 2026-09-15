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
  { argv: ['issue', 'ISS-<n>'], says: 'one issue with its edges' },
  { argv: ['issue', '--search', '<q>'], says: 'issues matching text' },
  { argv: ['guide', '<slug>'], says: 'the method for a topic' },
];

/** One line for the tool description. */
export function readFormsLine(): string {
  const forms = READ_FORMS.map((f) => `\`${f.argv.join(' ')}\` (${f.says})`).join(', ');
  return `Read forms that need no -h: ${forms}.`;
}

/** A Usage line, read as the options it names (with whether each takes an operand) and how many positionals it takes. */
export interface UsageShape {
  readonly options: ReadonlyMap<string, boolean>;
  readonly positionals: number;
}

/** `Usage: forge issue [<uuid|ISS-45>] [--status s] …` → its shape. */
export function parseUsage(line: string): UsageShape {
  const after = line.replace(/^\s*Usage:\s*forge\s+\S+\s*/, '');
  const tokens = after.replace(/[[\]]/g, ' ').split(/\s+/).filter(Boolean);
  const options = new Map<string, boolean>();
  let positionals = 0;
  let seenOption = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t.startsWith('--')) {
      seenOption = true;
      const next = tokens[i + 1];
      const takesOperand = next !== undefined && !next.startsWith('--');
      for (const flag of t.split('|')) options.set(flag, takesOperand);
      if (takesOperand) i++;
    } else if (!seenOption) {
      positionals++;
    }
  }
  return { options, positionals };
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
  if (positionals > usage.positionals)
    problems.push(`${positionals} positional(s) carried, Usage line takes ${usage.positionals}`);
  return problems;
}
