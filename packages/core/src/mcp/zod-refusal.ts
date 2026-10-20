import { fieldsNear, schemaRefusalWords } from '../lib/zod-sentences.js';

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

/** "This call takes `documentId`, which may be what `id` meant." for each stray field with a near one. */
function nearSentences(issues: readonly unknown[], schema: JsonNode): string[] {
  const said: string[] = [];
  for (const issue of issues as { code?: string; keys?: string[]; path?: PropertyKey[] }[]) {
    if (issue.code !== 'unrecognized_keys') continue;
    const known = fieldsAt(schema, issue.path ?? []);
    const at = (issue.path ?? []).map(String).join('.');
    const named = (k: string) => `\`${at ? `${at}.${k}` : k}\``;
    for (const key of issue.keys ?? []) {
      const near = fieldsNear(key, known).map(named);
      if (near.length === 0) continue;
      const listed =
        near.length === 1 ? near[0] : `${near.slice(0, -1).join(', ')} and ${near.at(-1)}`;
      said.push(
        `This call takes ${listed}, ${near.length === 1 ? 'which' : 'either of which'} may be what ${named(key)} meant.`,
      );
    }
  }
  return said;
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
  });
  const near = inputSchema ? nearSentences(issues, inputSchema as JsonNode) : [];
  const lines = accepted.map(
    (a) => `\`${a.field}\` takes: ${a.values.map((v) => JSON.stringify(v)).join(', ')}`,
  );
  return [`BAD_REQUEST: ${[...sentences, ...near].join(' ')}`, ...lines].join('\n');
}
