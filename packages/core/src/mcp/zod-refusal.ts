import { schemaRefusalWords } from '../lib/zod-sentences.js';

/**
 * A tool input the schema refused: a sentence per field saying what is wrong with it, then, on a
 * line of its own for each field held to a fixed set, the values it takes.
 */
export function zodRefusalMessage(err: unknown): string | null {
  const issues = (err as { name?: unknown; issues?: unknown } | null)?.issues;
  if ((err as { name?: unknown } | null)?.name !== 'ZodError' || !Array.isArray(issues))
    return null;
  const { sentences, accepted } = schemaRefusalWords(issues, {
    quote: true,
    valuesAre: 'listed below',
  });
  const lines = accepted.map(
    (a) => `\`${a.field}\` takes: ${a.values.map((v) => JSON.stringify(v)).join(', ')}`,
  );
  return [`BAD_REQUEST: ${sentences.join(' ')}`, ...lines].join('\n');
}
