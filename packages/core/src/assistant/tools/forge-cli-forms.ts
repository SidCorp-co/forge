/**
 * ISS-1041 — the read forms the model repeats on every turn, carried in the
 * `forge` tool's description so a question costs no `-h` round.
 */

interface CliForm {
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
