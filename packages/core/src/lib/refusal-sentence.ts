import { flattenedRefusalWords, schemaRefusalWords } from './zod-sentences.js';

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
export function reasonWords(details: unknown): string[] {
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
  return flattenedRefusalWords(details);
}

/** Whether `details` hold any text a reader could be told: a string anywhere inside them. */
export function holdsReason(details: unknown): boolean {
  if (typeof details === 'string') return details.trim() !== '';
  if (Array.isArray(details)) return details.some(holdsReason);
  if (details !== null && typeof details === 'object')
    return Object.values(details).some(holdsReason);
  return false;
}

/** A 4xx message, the envelope's funnel: a bare refusal says the reason its details carry. */
export function refusalMessage(message: string, details: unknown): string {
  const said = message.trim();
  if (isBareRefusal(said)) {
    const words = reasonWords(details);
    if (words.length > 0) return words.join(' ');
    return said === '' ? NOTHING_SAID : INPUT_REFUSED;
  }
  return refusalSentence(message);
}
