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
      sentences.push(asSentence(issue.message ?? 'The input was refused'));
    } else if (issue.code === 'invalid_value' && issue.values?.length) {
      // The issue does not say whether the field was absent or held another value, so neither is claimed.
      // A schema's own message ("`pass_rate` is retired") says more than the library's default.
      const own = issue.message && !/^Invalid option/.test(issue.message);
      sentences.push(
        `The field ${named(field)} takes one of the values ${valuesAre}.${own ? ` ${asSentence(issue.message ?? '')}` : ''}`,
      );
      accepted.push({ field, values: issue.values.map(String) });
    } else if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message ?? '')) {
      sentences.push(`The field ${named(field)} is required.`);
    } else {
      sentences.push(`The field ${named(field)} was refused. ${asSentence(issue.message ?? '')}`);
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
