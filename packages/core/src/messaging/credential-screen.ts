/**
 * The one credential screen: what the reply check refuses, and what nothing a reader receives or a room
 * stores may carry, whatever kind of block holds it (ISS-1229 r43, r44).
 */
import { FILTERED, scrubLogText } from '@forge/observability';
import type { ContentBlock } from '../lib/agent-stream-parser.js';

const JSON_CONTAINER = /^[ \t\n\r]*[[{]/;

/** Every string a JSON object or array written as `text` holds, at any depth, and inside those in turn. */
function stringsWithin(text: string): string[] {
  if (!JSON_CONTAINER.test(text)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.push(value, ...stringsWithin(value));
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  };
  walk(parsed);
  return found;
}

const scrubbed = (text: string): boolean => scrubLogText(text) !== text;

/**
 * Whether the reply check reads `text` as holding a credential: the secret scrubber changes it, or a string
 * it holds as JSON. The refusal, a withdrawn draft and every block a reader is sent answer to this alone.
 */
export function readsAsCredential(text: string): boolean {
  return scrubbed(text) || stringsWithin(text).some(scrubbed);
}

const PEM_HEADER = /-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/;

/**
 * Prose as a reader may see it while it is still being written: scrubbed, and cut at a private key's
 * header, whose body the scrubber only matches once 16 characters of it exist.
 */
export function shownWhileWritten(text: string): string {
  const key = PEM_HEADER.exec(text);
  return scrubLogText(key ? text.slice(0, key.index) + FILTERED : text);
}

/** A string through the screen: as it is, else scrubbed, else withheld whole where the scrub left one. */
export function screenedText(text: string): string {
  if (!readsAsCredential(text)) return text;
  const shown = shownWhileWritten(text);
  return readsAsCredential(shown) ? FILTERED : shown;
}

/** A copy of `value` with every string it holds, at any depth, through the screen; keys are kept. */
export function screened<T>(value: T, text: (s: string) => string = screenedText): T {
  if (typeof value === 'string') return text(value) as T;
  if (Array.isArray(value)) return value.map((v) => screened(v, text)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, screened(v, text)]),
    ) as T;
  }
  return value;
}

type ProseKind = 'text' | 'thinking';

/**
 * Blocks of every kind through the screen. A tool call splits one run of prose into blocks, so a key and
 * its value can sit in two: where the run joined up reads as a credential, it is one block after the others.
 */
export function screenedBlocks(
  blocks: readonly ContentBlock[],
  text: (s: string) => string = screenedText,
): ContentBlock[] {
  let out = blocks.map((b) => ({ ...b }));
  for (const kind of ['text', 'thinking'] as const satisfies readonly ProseKind[]) {
    const prose = out.filter((b) => b.type === kind && b[kind] !== undefined);
    const joined = prose.map((b) => b[kind]).join('');
    const shown = text(joined);
    if (shown !== joined && prose.length > 1) {
      out = [...out.filter((b) => !prose.includes(b)), { type: kind, [kind]: shown }];
    }
  }
  return screened(out, text);
}
