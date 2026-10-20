import { flattenedRefusalWords } from './zod-sentences.js';

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

/** A 4xx message, the envelope's funnel: a bare refusal over flattened errors becomes a sentence per field. */
export function refusalMessage(message: string, details: unknown): string {
  const said = message.trim();
  if (isBareRefusal(said)) {
    const words = flattenedRefusalWords(details);
    if (words.length > 0) return words.join(' ');
    return said === '' ? 'The request was refused.' : 'The input was refused.';
  }
  return refusalSentence(message);
}
