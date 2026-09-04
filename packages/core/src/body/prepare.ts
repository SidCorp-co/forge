/**
 * The one entry point every write door calls, and the one every read path
 * calls back.
 *
 * There is exactly one of each on purpose. `refuseUnrecordedClose` states the
 * shape of the rule this follows: a gate on some doors is a gate on none, and
 * a body reaches core through seven caller-supplied doors (two REST comment
 * routes, two MCP comment actions, issue create, issue patch
 * children). They converge here rather than each carrying a copy.
 *
 * `prepareBody` throws `BodyInvalidError`; the transport maps it to 400.
 * `bodyText` NEVER throws — it reads rows that are already stored, and a read
 * path that can refuse its own data takes the whole issue view down.
 */

import { BodyInvalidError } from './errors.js';
import type { BodyFormat } from './formats.js';
import { serializeBody } from './normalize.js';
import { parseBody } from './parse.js';
import { bodyToText, validateBody } from './validate.js';

export interface PreparedBody {
  body: string;
  format: BodyFormat;
  template: string | null;
  slots: Record<string, unknown> | null;
  warnings: string[];
  /** The compact projection the prompt, the indexer and both MCP tools read. */
  text: string;
}

export interface PrepareInput {
  raw: string;
  format?: BodyFormat | null | undefined;
}

/**
 * Which renderer a body gets when the caller did not say.
 *
 * Absent → `markdown`, and that default is load-bearing: every shipped
 * `forge_comments → create` example in `packages/core/skills/**` omits
 * `format`, so any other default would refuse them all at the agent's first
 * call. A body that OPENS with a component is taken as `html` because there is
 * no reading of `<forge-review …>` as markdown that anybody wanted.
 */
// cm:edge contract -> packages/core/skills — the `markdown` default is what keeps every shipped SKILL.md `forge_comments → create` example valid unchanged; `skills/shipped-templates.test.ts` parses them against the strict schema. Flip this default and ISS-898 P1 blinds every reader at once, which is exactly the ordering Decision 9 forbids.
export function resolveFormat(input: PrepareInput): BodyFormat {
  if (input.format) return input.format;
  const head = input.raw.trimStart();
  return head.startsWith('<forge-') ? 'html' : 'markdown';
}

const MARKDOWN_PASSTHROUGH = (raw: string): PreparedBody => ({
  body: raw,
  format: 'markdown',
  template: null,
  slots: null,
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
    template: validated.template,
    slots: validated.slots,
    warnings: validated.warnings,
    text: bodyToText(validated.nodes),
  };
}

/**
 * The compact text projection of a STORED body.
 *
 * Four read paths call this: `prompt/user.ts`, `memory/indexer.ts`, and both
 * MCP serializers. ISS-898's proposal named only the first two; under
 * thin-init the prompt inlines the title alone by default, so the MCP
 * serializers are what actually carry a description or a comment to an agent —
 * wiring only the named pair would project almost none of the bytes.
 */
// cm:guard never let this throw. It reads rows already in the table, including any written before a registry change, and a read path that refuses its own data takes the issue view and the agent prompt down together. An unparseable stored body degrades to its own bytes.
export function bodyText(body: string, format: string | null | undefined): string {
  if (!readsAsHtml(body, format)) return body;
  try {
    return bodyToText(parseBody(body)) || body;
  } catch {
    return body;
  }
}

/**
 * An ABSENT format is sniffed rather than assumed `markdown`.
 *
 * Both columns are NOT NULL, so null never comes off a row — it means a caller
 * lost the field in transit, and one does: `track` in `issues/routes.ts` drops
 * a field whose value did not move, so the unconditional
 * `onChange('descriptionFormat')` in `patch-fields.ts` never reaches
 * `issueUpdated` when a body was edited without changing format. Measured live
 * on forge-beta 2026-09-03: ISS-899's html description was re-embedded as raw
 * `<forge-problem>` markup, spending its vector budget on tag names.
 *
 * Fixed HERE and not at that call site because there are four readers and the
 * format can be lost on any route into them; a reader that cannot be blinded
 * is worth more than one event made complete. An explicit `'markdown'` still
 * wins, so a markdown row can never be misread as markup.
 */
// cm:guard the sniff must stay the SAME rule as `resolveFormat`'s — a body that opens with `<forge-` is html on the way in and on the way out, or a body stores one way and reads the other
function readsAsHtml(body: string, format: string | null | undefined): boolean {
  if (format === 'html') return true;
  if (format) return false;
  return body.trimStart().startsWith('<forge-');
}

/** Parsed slots of a STORED body, for the MCP read surface. Never throws. */
export function bodySlots(
  body: string,
  format: string | null | undefined,
): Record<string, unknown> | null {
  if (!readsAsHtml(body, format)) return null;
  try {
    return validateBody(parseBody(body)).slots;
  } catch {
    return null;
  }
}
