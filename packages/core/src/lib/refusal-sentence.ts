import { flattenedRefusalWords, schemaRefusalWords, zodMessageWords } from './zod-sentences.js';

/** Codes that lead an MCP refusal (`BAD_REQUEST: ISSUE_KEY_NOT_HELD: …`); they stay as written. */
const LEADING_CODES = /^(?:[A-Z][A-Z0-9_]*:\s*)*/;
const ENDED = /[.!?]["'`)\]]*$/;

/** A word that names a field or a value (`projectId`, `release_chain`, `data.status`), not prose. */
function isIdentifier(word: string): boolean {
  const bare = word.replace(/[,:;.]+$/, '');
  return /[A-Z_./:\d-]/.test(bare.slice(1)) || /[_(]/.test(bare);
}

function opened(body: string): string {
  if (!/^[a-z]/.test(body)) return body;
  const word = body.match(/^\S+/)?.[0] ?? '';
  if (!isIdentifier(word)) return body.charAt(0).toUpperCase() + body.slice(1);
  const bare = word.replace(/[,:;.]+$/, '');
  return `\`${bare}\`${body.slice(bare.length)}`;
}

/** "Invalid input", or nothing: a refusal that says nothing of what was wrong. */
export function isBareRefusal(message: string): boolean {
  return /^(?:Invalid input\.?)?$/.test(message.trim());
}

export function isRefusalSentence(text: string): boolean {
  const first = (text.split('\n')[0] ?? '').replace(LEADING_CODES, '').trim();
  return (
    first.length > 0 &&
    !/^[a-z]/.test(first) &&
    ENDED.test(first) &&
    !/^Invalid input\b/.test(first)
  );
}

/** The first line made a sentence: its opening capitalised (an identifier quoted), a full stop added. */
export function refusalSentence(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const codes = first.match(LEADING_CODES)?.[0] ?? '';
  let body = first.slice(codes.length).trim();
  if (!body) return text;
  body = opened(body);
  if (!ENDED.test(body)) body = `${body.replace(/[\s,;:—-]+$/, '')}.`;
  return [`${codes}${body}`, ...rest].join('\n');
}

/** What a refusal says when its door gave no reason anywhere: never said beside one (ISS-1421 r16). */
const NOTHING_SAID = 'The request was refused.';
const INPUT_REFUSED = 'The input was refused.';
export const NO_REASON_GIVEN: readonly string[] = [NOTHING_SAID, INPUT_REFUSED];

const LONE_REASON_KEYS = ['message', 'reason', 'error'];

function isIssue(v: unknown): v is { message: string; path?: PropertyKey[] } {
  return (
    v !== null && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string'
  );
}

/**
 * The reason a door wrote into a refusal's `details`, in sentences: a sentence of its own, a list
 * of them, a schema's issues, a lone `message`, or a record naming fields at any depth.
 */
export function reasonWords(details: unknown, sent?: (field: string) => unknown): string[] {
  if (typeof details === 'string') return details.trim() ? [refusalSentence(details.trim())] : [];
  if (Array.isArray(details)) {
    if (details.length > 0 && details.every(isIssue))
      return schemaRefusalWords(details, { valuesAre: 'listed in details' }).sentences;
    return details.flatMap((d) => (typeof d === 'string' ? reasonWords(d) : []));
  }
  if (details === null || typeof details !== 'object') return [];
  const keys = Object.keys(details);
  const lone = keys.length === 1 && LONE_REASON_KEYS.includes(keys[0] ?? '');
  const said = lone ? (details as Record<string, unknown>)[keys[0] ?? ''] : undefined;
  if (typeof said === 'string') return reasonWords(said);
  return flattenedRefusalWords(details, '', sent);
}

/** Whether `details` hold any text a reader could be told: a string anywhere inside them. */
export function holdsReason(details: unknown): boolean {
  if (typeof details === 'string') return details.trim() !== '';
  if (Array.isArray(details)) return details.some(holdsReason);
  if (details !== null && typeof details === 'object')
    return Object.values(details).some(holdsReason);
  return false;
}

/** A label and nothing more ("invalid params"), which yields to the fields its details name. */
const LABEL_ONLY = /^invalid(?:\s+[A-Za-z]+){0,2}\.?$/i;

function isSchemaDetails(details: unknown): boolean {
  if (Array.isArray(details)) return details.length > 0 && details.every(isIssue);
  if (details === null || typeof details !== 'object') return false;
  // A resolver may key its reason as `{ formErrors }` alone: the same shape, with no field to name.
  const d = details as { formErrors?: unknown; fieldErrors?: unknown };
  const keyedOnly = Object.keys(details).every((k) => k === 'formErrors' || k === 'fieldErrors');
  if (Array.isArray(d.formErrors) && d.fieldErrors === undefined) return keyedOnly;
  return Array.isArray(d.formErrors) && typeof d.fieldErrors === 'object';
}

export function isLabelOnly(message: string): boolean {
  return LABEL_ONLY.test(message.trim());
}

/**
 * A 4xx message, the envelope's funnel: a bare refusal says the reason its details carry, and
 * `sent` reads what the request sent at a field, so a refused value is quoted.
 */
export function refusalMessage(
  message: string,
  details: unknown,
  sent?: (field: string) => unknown,
): string {
  const said = message.trim();
  const labelled =
    LABEL_ONLY.test(said) && isSchemaDetails(details) && reasonWords(details, sent).length > 0;
  if (isBareRefusal(said) || labelled) {
    const words = reasonWords(details, sent);
    if (words.length > 0) return words.join(' ');
    return said === '' ? NOTHING_SAID : INPUT_REFUSED;
  }
  return refusalSentence(message);
}

/** A refusal's details in the shape a schema's take: the input's own sentences, and each field's. */
export interface KeyedReasons {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

/** Each field a record of reasons names, nested ones by their whole path; false where a value is data. */
function keyFields(
  record: Record<string, unknown>,
  at: string,
  into: Record<string, string[]>,
  sent?: (field: string) => unknown,
): boolean {
  for (const [key, v] of Object.entries(record)) {
    const field = at ? `${at}.${key}` : key;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (!keyFields(v as Record<string, unknown>, field, into, sent)) return false;
      continue;
    }
    const list = Array.isArray(v) ? v : [v];
    if (list.length === 0 || !list.every((x) => typeof x === 'string')) return false;
    into[field] = flattenedRefusalWords({ [field]: list }, '', sent);
  }
  return true;
}

/**
 * A reason a door wrote in its own shape (a sentence, a list of them, a lone `message`, a record of
 * field to words), keyed as a schema's refusal is and said in the message's sentences (ISS-1421
 * r21). Null for details that are a schema's already, or that carry anything but words.
 */
export function keyedReasons(
  details: unknown,
  sent?: (field: string) => unknown,
): KeyedReasons | null {
  if (typeof details === 'string') {
    const said = reasonWords(details);
    return said.length > 0 ? { formErrors: said, fieldErrors: {} } : null;
  }
  if (Array.isArray(details)) {
    if (details.length === 0 || !details.every((d) => typeof d === 'string')) return null;
    return { formErrors: details.flatMap((d) => reasonWords(d)), fieldErrors: {} };
  }
  if (details === null || typeof details !== 'object' || isSchemaDetails(details)) return null;
  const keys = Object.keys(details);
  const only = keys.length === 1 ? (keys[0] ?? '') : '';
  if (LONE_REASON_KEYS.includes(only)) {
    const said = (details as Record<string, unknown>)[only];
    return typeof said === 'string' ? keyedReasons(said) : null;
  }
  const fieldErrors: Record<string, string[]> = {};
  if (!keyFields(details as Record<string, unknown>, '', fieldErrors, sent)) return null;
  return Object.keys(fieldErrors).length > 0 ? { formErrors: [], fieldErrors } : null;
}

/**
 * A 4xx refusal's message and details as the envelope answers them. Where the message is the
 * door's reason, read off its details, those details are keyed as a schema's refusal is and say
 * each sentence the message says, so a reader fixing its call from either reads one account.
 */
export function refusalBody(
  message: string,
  details: unknown,
  sent?: (field: string) => unknown,
): { message: string; details?: unknown } {
  if (isBareRefusal(message)) {
    const keyed = keyedReasons(details, sent);
    if (keyed) {
      const said = [...keyed.formErrors, ...Object.values(keyed.fieldErrors).flat()];
      return { message: said.join(' '), details: keyed };
    }
  }
  return {
    message: refusalMessage(message, details, sent),
    ...(details === undefined ? {} : { details: wordedDetails(details, sent) }),
  };
}

/**
 * Refusal details in `z.flattenError`'s shape with each message a door kept as the library wrote it
 * ("Invalid input: expected number, received NaN") said as the sentence the message says it in;
 * a sentence already, and every other shape of details, is kept as sent (ISS-1421 r19).
 */
export function wordedDetails(details: unknown, sent?: (field: string) => unknown): unknown {
  if (!isSchemaDetails(details) || Array.isArray(details)) return details;
  const d = details as { formErrors: unknown[]; fieldErrors: Record<string, unknown> };
  const said = (m: unknown, field: string | null): unknown => {
    if (typeof m !== 'string' || isRefusalSentence(m)) return m;
    return field === null
      ? zodMessageWords(null, m)
      : (flattenedRefusalWords({ [field]: m }, '', sent)[0] ?? m);
  };
  const fieldErrors = Object.fromEntries(
    Object.entries(d.fieldErrors ?? {}).map(([field, v]) => [
      field,
      Array.isArray(v) ? v.map((m) => said(m, field)) : said(v, field),
    ]),
  );
  return { ...d, formErrors: d.formErrors.map((m) => said(m, null)), fieldErrors };
}
