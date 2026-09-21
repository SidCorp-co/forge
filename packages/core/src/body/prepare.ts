import { BodyInvalidError } from './errors.js';
import type { BodyFormat } from './formats.js';
import { serializeBody } from './normalize.js';
import { type BodyNode, parseBody } from './parse.js';
import { bodyToText, validateBody } from './validate.js';

export interface PreparedBody {
  body: string;
  format: BodyFormat;
  warnings: string[];
  /** The compact projection the prompt, the indexer and both MCP tools read. */
  text: string;
}

export interface PrepareInput {
  raw: string;
  format?: BodyFormat | null | undefined;
}

export function resolveFormat(input: PrepareInput): BodyFormat {
  if (input.format) return input.format;
  const head = input.raw.trimStart();
  return head.startsWith('<forge-') ? 'html' : 'markdown';
}

const MARKDOWN_PASSTHROUGH = (raw: string): PreparedBody => ({
  body: raw,
  format: 'markdown',
  warnings: [],
  text: raw,
});

export function prepareBody(input: PrepareInput): PreparedBody {
  const format = resolveFormat(input);
  if (format === 'markdown') return MARKDOWN_PASSTHROUGH(input.raw);

  const validated = validateBody(parseBody(input.raw));
  const body = serializeBody(validated.nodes);
  if (body.trim().length === 0) {
    throw new BodyInvalidError('the body is empty once markup outside the allowlist is removed', {
      warnings: validated.warnings,
    });
  }
  return {
    body,
    format,
    warnings: validated.warnings,
    text: bodyToText(validated.nodes),
  };
}

export function bodyText(body: string, format: string | null | undefined): string {
  if (!readsAsHtml(body, format)) return body;
  try {
    return bodyToText(parseBody(body)) || body;
  } catch {
    return body;
  }
}

function readsAsHtml(body: string, format: string | null | undefined): boolean {
  if (format === 'html') return true;
  if (format) return false;
  return body.trimStart().startsWith('<forge-');
}

/**
 * The node tree of a STORED body, for the web renderer. Never throws.
 *
 * `parseBody` alone, deliberately without `validateBody`: the bytes in the
 * column were validated on the way in, and a row written against an OLDER
 * registry must still reach the screen. A component this build no longer
 * declares arrives as an ordinary element and web draws its generic card —
 * which is the whole of ISS-967 gap 6, with no second name list anywhere.
 */
export function bodyNodes(body: string, format: string | null | undefined): BodyNode[] | null {
  if (!readsAsHtml(body, format)) return null;
  try {
    return parseBody(body);
  } catch {
    return null;
  }
}
