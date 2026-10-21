import { HTTPException } from 'hono/http-exception';
import type { ZodType, z } from 'zod';
import { fieldsNamedAt } from './unknown-fields.js';

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
  /** A discriminated union's own values for its discriminator, on the issue that refuses it. */
  options?: readonly unknown[];
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
  const phrase = ownPhrase(said);
  if (field && phrase) return `${subject} ${phrase}`;
  const named = field ? fieldLed(field, said) : null;
  if (named) return named;
  return `${subject} was refused. ${asSentence(said || 'It did not match its schema')}`;
}

/**
 * A door's own message that opens on the field it is about ("limit must be between 1 and 500",
 * "agentConfig.stateContext decides nothing"), said as one sentence of that field, so its name is
 * neither said twice nor capitalised into a name it does not have (ISS-1421 r19).
 */
function fieldLed(field: string, said: string): string | null {
  const bare = field.replace(/`/g, '');
  const first = said.match(/^\S+/)?.[0] ?? '';
  if (first !== bare && !first.endsWith(`.${bare}`)) return null;
  const rest = said.slice(first.length).trim();
  // "metric `vibes` is …" uses the field's name as a noun; only a word after it makes it the subject.
  if (!/^[a-z]/.test(rest)) return null;
  return `The field ${first === bare ? field : first} ${/[.!?]$/.test(rest) ? rest : `${rest}.`}`;
}

/** A door's own phrase about a field ("required", "must be a uuid"), said of that field. */
function ownPhrase(said: string): string | null {
  if (said === 'required') return 'is required.';
  if (said === 'not found') return 'was not found.';
  if (/^(?:is|are|was|must|does|do|has|cannot|takes|belongs|issued)\b/.test(said)) {
    const verb = said.startsWith('issued') ? `was ${said}` : said;
    return /[.!?]$/.test(verb) ? verb : `${verb}.`;
  }
  return null;
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

/** A field whose value a refusal never repeats, by the last word of its name: a secret, a token, a key. */
const SECRET_FIELD = /(?:secret|token|password|passphrase|credential|key|pem)$/i;

/** The most of a sent value a refusal quotes. */
const QUOTED_MOST = 40;

/**
 * What the caller sent, quoted as they typed it (ISS-1421 r18): no JSON escaping, at most
 * `QUOTED_MOST` characters, and nothing at all for a field that holds a secret.
 */
export function quotedSent(field: string, sent: unknown): string | null {
  if (SECRET_FIELD.test(field)) return null;
  if (typeof sent === 'boolean') return String(sent);
  if (typeof sent !== 'string') return null;
  return `"${sent.length > QUOTED_MOST ? `${sent.slice(0, QUOTED_MOST)}…` : sent}"`;
}

/** A field that takes a number, said with the value sent where it is known. */
function notANumber(subject: string, quoted: string | null): string {
  return `${subject} takes a number, ${quoted ? `not ${quoted}` : 'and the value sent is not one'}.`;
}

/** zod's message for a number field sent no number, whether coerced (NaN) or not. */
const NUMBER_NOT_SENT = /^Invalid input: expected number, received (?:NaN|string|boolean)$/;

/** zod's default messages, each with the words it is said in; the first pattern that matches wins. */
const ZOD_WORDS: ReadonlyArray<[RegExp, (subject: string, m: RegExpExecArray) => string]> = [
  [/^Invalid input: expected \w+, received undefined$/, (s) => `${s} is required.`],
  [/^Invalid input: expected date, received Date$/, (s) => `${s} is not a valid date.`],
  [/^Invalid input: expected number, received NaN$/, (s) => notANumber(s, null)],
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
export function flattenedRefusalWords(
  details: unknown,
  at = '',
  sent?: (field: string) => unknown,
): string[] {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return [];
  const d = details as { formErrors?: unknown; fieldErrors?: unknown };
  const listOf = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
  const flattened = Array.isArray(d.formErrors) && typeof d.fieldErrors === 'object';
  const form = flattened ? listOf(d.formErrors) : [];
  const fields = (flattened ? d.fieldErrors : details) as Record<string, unknown>;
  return [
    ...form.map((m) => zodMessageWords(at || null, m)),
    ...Object.entries(fields ?? {}).flatMap(([key, v]) => {
      const field = at ? `${at}.${key}` : key;
      // A record nested under a field ("config": { "url": "required" }) names each field inside it.
      if (v !== null && typeof v === 'object' && !Array.isArray(v))
        return flattenedRefusalWords(v, field, sent);
      return listOf(v).map((m) => {
        const quoted = NUMBER_NOT_SENT.test(m) ? quotedSent(field, sent?.(field)) : null;
        return quoted ? notANumber(`The field ${field}`, quoted) : zodMessageWords(field, m);
      });
    }),
  ];
}

/**
 * The fields of `known` a stray `sent` may have meant: one whose name, case ignored, ends with it,
 * or lies at most two single-letter insertions, deletions or substitutions from it (ISS-1421 r16).
 */
export function fieldsNear(sent: string, known: readonly string[]): string[] {
  const s = sent.toLowerCase();
  return known.filter((k) => {
    if (k === sent) return false;
    const name = k.toLowerCase();
    return name.endsWith(s) || editDistance(name, s) <= 2;
  });
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const swap = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, swap));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * "This call takes `documentId`, which may be what `id` meant." for each stray key: the fields near
 * it beside it, or, with none there, those near it one level down (`filters.issue` for `issueid`).
 */
function nearSentences(
  keys: readonly string[],
  path: readonly PropertyKey[],
  fieldsAt: (path: readonly PropertyKey[]) => readonly string[],
  named: (field: string) => string,
): string[] {
  const at = path.map(String).join('.');
  const full = (k: string) => named(at ? `${at}.${k}` : k);
  const known = fieldsAt(path);
  const below = known.flatMap((k) => fieldsAt([...path, k]).map((c) => ({ k, c })));
  return keys.flatMap((key) => {
    let near = fieldsNear(key, known);
    if (near.length === 0) {
      const down = below.filter(({ c }) => c === key || fieldsNear(key, [c]).length > 0);
      near = down.map(({ k, c }) => `${k}.${c}`);
    }
    if (near.length === 0) return [];
    const which = near.length === 1 ? 'which' : 'either of which';
    return [`This call takes ${joined(near.map(full))}, ${which} may be what ${full(key)} meant.`];
  });
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let at = input;
  for (const segment of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<PropertyKey, unknown>)[segment];
  }
  return at;
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
  {
    quote = false,
    valuesAre,
    fieldsAt,
    input,
    quoteFrom = input,
  }: {
    quote?: boolean;
    valuesAre: string;
    /** The body or query exactly as the caller sent it. */
    input?: unknown;
    /** What a refused value is quoted from where `input` is not the parsed value itself. */
    quoteFrom?: unknown;
    /** The fields the schema names at a path, so a stray field there is followed by those near it. */
    fieldsAt?: (path: readonly PropertyKey[]) => readonly string[];
  },
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
      if (fieldsAt) sentences.push(...nearSentences(issue.keys, issue.path ?? [], fieldsAt, named));
    } else if (!field) {
      sentences.push(zodMessageWords(null, issue.message ?? ''));
    } else if (
      (issue.code === 'invalid_value' && issue.values?.length) ||
      (issue.code === 'invalid_union' && issue.options?.length)
    ) {
      // The issue does not say whether the field was absent or held another value, so neither is claimed.
      // A schema's own message ("`pass_rate` is retired") says more than the library's default, and a
      // discriminator's ("Invalid discriminator value. Expected …") is the library's own (ISS-1421 r15).
      // A schema's own reason leads, the values after it (ISS-1421 r19).
      const own = issue.message && !/^Invalid (?:option|input|discriminator)\b/.test(issue.message);
      const values = `The field ${named(field)} takes one of the values ${valuesAre}.`;
      const reason = fieldLed(named(field), issue.message ?? '') ?? asSentence(issue.message ?? '');
      sentences.push(own ? `${reason} ${values}` : values);
      accepted.push({ field, values: (issue.values ?? issue.options ?? []).map(String) });
    } else if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message ?? '')) {
      sentences.push(`The field ${named(field)} is required.`);
    } else if (issue.code === 'invalid_type' && /received NaN$/.test(issue.message ?? '')) {
      // A coerced number that read as NaN: "NaN" is a word the caller never typed (ISS-1421 r17).
      const sent = valueAt(input, issue.path ?? []);
      sentences.push(
        input !== undefined && sent === undefined
          ? `The field ${named(field)} is required.`
          : notANumber(
              `The field ${named(field)}`,
              quotedSent(field, valueAt(quoteFrom, issue.path ?? [])),
            ),
      );
    } else if (
      NUMBER_NOT_SENT.test(issue.message ?? '') &&
      quotedSent(field, valueAt(quoteFrom, issue.path ?? []))
    ) {
      // A number field sent a word is told what it was sent, not only its type (ISS-1421 r18).
      const quoted = quotedSent(field, valueAt(quoteFrom, issue.path ?? []));
      sentences.push(notANumber(`The field ${named(field)}`, quoted));
    } else {
      sentences.push(zodMessageWords(named(field), issue.message ?? ''));
    }
  }
  return { sentences, accepted };
}

/**
 * `z.flattenError`'s shape, each message the sentence the refusal says it in, so `details` never
 * carries the library's own words ("received NaN") that the message replaced (ISS-1421 r19).
 */
export function wordedFlatten(
  issues: readonly SchemaIssue[],
  words: Parameters<typeof schemaRefusalWords>[1],
): { formErrors: string[]; fieldErrors: Record<string, string[]> } {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const { sentences } = schemaRefusalWords([issue], words);
    const key = issue.path?.[0];
    if (key === undefined) formErrors.push(...sentences);
    else fieldErrors[String(key)] = [...(fieldErrors[String(key)] ?? []), ...sentences];
  }
  return { formErrors, fieldErrors };
}

/**
 * A REST door's 400 for an input its schema refused: the sentences as its message, and in details
 * the same sentences by field, beside the values each fixed-set field takes.
 */
export function schemaRefused(
  error: z.core.$ZodError,
  schema?: ZodType,
  input?: unknown,
): HTTPException {
  const words = {
    valuesAre: 'listed in details.accepted',
    input,
    ...(schema ? { fieldsAt: (path: readonly PropertyKey[]) => fieldsNamedAt(schema, path) } : {}),
  };
  const { sentences, accepted } = schemaRefusalWords(error.issues, words);
  const details = {
    ...wordedFlatten(error.issues, words),
    ...(accepted.length > 0
      ? { accepted: Object.fromEntries(accepted.map((a) => [a.field, a.values])) }
      : {}),
  };
  return new HTTPException(400, {
    message: sentences.join(' '),
    cause: { code: 'BAD_REQUEST', details },
  });
}

/**
 * A parse's issues as one run of sentences for a reader with no details to look in: an MCP answer,
 * a box's refusal, an error a stored row raised. Each field is named under `at`, and a fixed set's
 * values follow its sentence (ISS-1421 r20: these sites said zod's own words).
 */
export function issueSentences(
  issues: readonly SchemaIssue[],
  at: readonly PropertyKey[] = [],
): string {
  const placed = issues.map((i) => ({ ...i, path: [...at, ...(i.path ?? [])] }));
  const { sentences, accepted } = schemaRefusalWords(placed, { valuesAre: 'named next' });
  const values = accepted.map((a) => `The values ${a.field} takes are ${a.values.join(', ')}.`);
  return [...sentences, ...values].join(' ');
}
