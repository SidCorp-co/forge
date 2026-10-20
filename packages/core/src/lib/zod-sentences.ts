import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

/**
 * A schema refusal in a reader's words: what was wrong and where, one capitalised sentence each,
 * ending with a full stop. The values a field accepts are data, never part of the sentence, so a
 * caller puts them in its details or on a line of their own (ISS-1421 r14).
 */

interface SchemaIssue {
  code?: string;
  path?: readonly PropertyKey[];
  message?: string;
  keys?: readonly string[];
  values?: readonly unknown[];
}

export interface SchemaRefusalWords {
  sentences: string[];
  /** Each field refused for a value outside a fixed set, with the values it takes. */
  accepted: { field: string; values: string[] }[];
}

function asSentence(text: string): string {
  const t = text.trim();
  const opened = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

function article(type: string): string {
  if (type === 'null' || type === 'undefined' || type === 'NaN') return type;
  return /^[aeiou]/i.test(type) ? `an ${type}` : `a ${type}`;
}

/**
 * One of zod's own messages, which open "Invalid input: expected …", said of the field it is about.
 * A message a schema wrote itself is kept after the field is named.
 */
export function zodMessageWords(field: string | null, message: string): string {
  const subject = field ? `The field ${field}` : 'The input';
  const said = message.trim();
  for (const [pattern, words] of ZOD_WORDS) {
    const m = pattern.exec(said);
    if (m) return words(subject, m);
  }
  if (!field && said) return asSentence(said);
  return `${subject} was refused. ${asSentence(said || 'It did not match its schema')}`;
}

const BOUND_WORDS: Record<string, string> = {
  '>=': 'at least',
  '>': 'more than',
  '<=': 'at most',
  '<': 'less than',
};

function boundWords(subject: string, m: RegExpExecArray): string {
  const [, , type, op = '', bound, unit] = m;
  if ((type === 'string' || type === 'array') && op === '>=' && bound === '1')
    return `${subject} cannot be empty.`;
  const units = bound === '1' && unit ? unit.replace(/s$/, '') : unit;
  return `${subject} takes ${BOUND_WORDS[op] ?? op} ${bound}${units ? ` ${units}` : ''}.`;
}

/** zod's default messages, each with the words it is said in; the first pattern that matches wins. */
const ZOD_WORDS: ReadonlyArray<[RegExp, (subject: string, m: RegExpExecArray) => string]> = [
  [/^Invalid input: expected \w+, received undefined$/, (s) => `${s} is required.`],
  [/^Invalid input: expected date, received Date$/, (s) => `${s} is not a valid date.`],
  [
    /^Invalid input: expected (\w+), received (\w+)$/,
    (s, m) => `${s} takes ${article(m[1] ?? '')}, not ${article(m[2] ?? '')}.`,
  ],
  [
    /^Invalid (?:input|option): expected one of (.+)$/,
    (s, m) => `${s} takes one of ${(m[1] ?? '').split('|').join(', ')}.`,
  ],
  [/^Invalid input: expected (.+)$/, (s, m) => `${s} takes ${m[1]}.`],
  [/^Invalid input$/, (s) => `${s} matches none of the forms it takes.`],
  [/^Too (small|big): expected (\w+) to (?:have|be) ([<>]=?)(\S+)(?: (\w+))?$/, boundWords],
  [/^Unrecognized keys?: (.+)$/, (s, m) => `${s} holds ${m[1]}, which this call does not take.`],
  [/^Invalid (?:string|number): (.+)$/, (s, m) => asSentence(`${s} ${m[1]}`)],
  [/^Invalid ([A-Za-z ]+)$/, (s, m) => `${s} is not a valid ${m[1]?.replace(/^ISO /, '')}.`],
];

/**
 * Sentences for refusal details already flattened to `{ formErrors, fieldErrors }`, or to a plain
 * record of field to message, for a door that kept only those.
 */
export function flattenedRefusalWords(details: unknown): string[] {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return [];
  const d = details as { formErrors?: unknown; fieldErrors?: unknown };
  const listOf = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
  const flattened = Array.isArray(d.formErrors) && typeof d.fieldErrors === 'object';
  const form = flattened ? listOf(d.formErrors) : [];
  const fields = (flattened ? d.fieldErrors : details) as Record<string, unknown>;
  return [
    ...form.map((m) => zodMessageWords(null, m)),
    ...Object.entries(fields ?? {}).flatMap(([field, v]) =>
      listOf(v).map((m) => zodMessageWords(field, m)),
    ),
  ];
}

function joined(names: readonly string[]): string {
  return names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * `quote` wraps each field name in backticks, for a reader that renders them as code; `valuesAre`
 * says where the caller puts the accepted values ("listed in details.accepted").
 */
export function schemaRefusalWords(
  issues: readonly SchemaIssue[],
  { quote = false, valuesAre }: { quote?: boolean; valuesAre: string },
): SchemaRefusalWords {
  const pathOf = (path: readonly PropertyKey[] = []) => path.map(String).join('.');
  const named = (field: string) => (quote ? `\`${field}\`` : field);
  const sentences: string[] = [];
  const accepted: SchemaRefusalWords['accepted'] = [];
  for (const issue of issues) {
    const field = pathOf(issue.path);
    if (issue.code === 'unrecognized_keys' && issue.keys?.length) {
      const fields = issue.keys.map((k) => named(field ? `${field}.${k}` : k));
      sentences.push(
        fields.length === 1
          ? `The field ${fields[0]} is not one this call takes.`
          : `The fields ${joined(fields)} are not ones this call takes.`,
      );
    } else if (!field) {
      sentences.push(zodMessageWords(null, issue.message ?? ''));
    } else if (issue.code === 'invalid_value' && issue.values?.length) {
      // The issue does not say whether the field was absent or held another value, so neither is claimed.
      // A schema's own message ("`pass_rate` is retired") says more than the library's default.
      const own = issue.message && !/^Invalid (?:option|input)\b/.test(issue.message);
      sentences.push(
        `The field ${named(field)} takes one of the values ${valuesAre}.${own ? ` ${asSentence(issue.message ?? '')}` : ''}`,
      );
      accepted.push({ field, values: issue.values.map(String) });
    } else if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message ?? '')) {
      sentences.push(`The field ${named(field)} is required.`);
    } else {
      sentences.push(zodMessageWords(named(field), issue.message ?? ''));
    }
  }
  return { sentences, accepted };
}

/**
 * A REST door's 400 for an input its schema refused: the sentences as its message, and in details
 * the flattened errors it always carried, beside the values each fixed-set field takes.
 */
export function schemaRefused(error: z.core.$ZodError): HTTPException {
  const { sentences, accepted } = schemaRefusalWords(error.issues, {
    valuesAre: 'listed in details.accepted',
  });
  const details = {
    ...z.flattenError(error),
    ...(accepted.length > 0
      ? { accepted: Object.fromEntries(accepted.map((a) => [a.field, a.values])) }
      : {}),
  };
  return new HTTPException(400, {
    message: sentences.join(' '),
    cause: { code: 'BAD_REQUEST', details },
  });
}
