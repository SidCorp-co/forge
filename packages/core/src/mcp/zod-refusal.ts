import { schemaRefusalWords } from '../lib/zod-sentences.js';

type JsonNode = {
  properties?: Record<string, JsonNode>;
  items?: JsonNode | JsonNode[];
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
  allOf?: JsonNode[];
};

/** The branches a JSON Schema node stands for: itself, and each of its unions and intersections. */
function branches(node: JsonNode): JsonNode[] {
  return [
    node,
    ...[...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap(branches),
  ];
}

/** Every field the tool's input schema names at `path`, across the branches of every union. */
function fieldsAt(schema: JsonNode, path: readonly PropertyKey[]): string[] {
  let nodes = [schema];
  for (const segment of path) {
    nodes = nodes.flatMap(branches).flatMap((n) => {
      if (typeof segment === 'number') return n.items ? [n.items].flat() : [];
      const next = n.properties?.[String(segment)];
      return next ? [next] : [];
    });
  }
  return [...new Set(nodes.flatMap(branches).flatMap((n) => Object.keys(n.properties ?? {})))];
}

/**
 * A tool input the schema refused: a sentence per field saying what is wrong with it, then, on a
 * line of its own for each field held to a fixed set, the values it takes. With the tool's input
 * schema, a field it does not take is followed by the fields near it that it does (ISS-1421 r16).
 */
export function zodRefusalMessage(
  err: unknown,
  inputSchema?: Record<string, unknown>,
): string | null {
  const issues = (err as { name?: unknown; issues?: unknown } | null)?.issues;
  if ((err as { name?: unknown } | null)?.name !== 'ZodError' || !Array.isArray(issues))
    return null;
  const { sentences, accepted } = schemaRefusalWords(issues, {
    quote: true,
    valuesAre: 'listed below',
    ...(inputSchema ? { fieldsAt: (path) => fieldsAt(inputSchema as JsonNode, path) } : {}),
  });
  const lines = accepted.map(
    (a) => `\`${a.field}\` takes: ${a.values.map((v) => JSON.stringify(v)).join(', ')}`,
  );
  return [`BAD_REQUEST: ${sentences.join(' ')}`, ...lines].join('\n');
}
