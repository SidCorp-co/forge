// The one credential screen: what the reply check refuses and no frame or stored block carries (ISS-1229 r44).
import { FILTERED, scrubLogText } from '@forge/observability';
import type { ContentBlock } from '../lib/agent-stream-parser.js';

const JSON_CONTAINER = /^[ \t\n\r]*[[{]/;

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

/** The secret scrubber changes `text`, or a string it holds as JSON at any depth. */
export function readsAsCredential(text: string): boolean {
  return scrubbed(text) || stringsWithin(text).some(scrubbed);
}

const PEM_HEADER = /-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/;

/** Scrubbed, and cut at a key header: the scrubber matches a key's body only from 16 characters. */
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

/** A value that passes alone can still read as a credential beside its key, as `{"password":"x"}` does. */
function keyedCredential(key: string, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (!readsAsCredential(JSON.stringify({ [key]: 'x' }))) return false;
  return readsAsCredential(JSON.stringify({ [key]: value }));
}

export function screened<T>(value: T, text: (s: string) => string = screenedText): T {
  if (typeof value === 'string') return text(value) as T;
  if (Array.isArray(value)) return value.map((v) => screened(v, text)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const shown = screened(v, text);
        return [k, shown === v && keyedCredential(k, v) ? FILTERED : shown];
      }),
    ) as T;
  }
  return value;
}

type ProseKind = 'text' | 'thinking';

/** Every block through the screen; prose a tool call split is screened joined up, as one block. */
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
