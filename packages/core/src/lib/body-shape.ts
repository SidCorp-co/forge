import { z } from 'zod';

type Node = {
  type?: string | string[];
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Node[];
  oneOf?: Node[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | Node;
};

const DEPTH_MAX = 3;
const SHAPE_MAX = 2500;

const range = (lo: number | undefined, hi: number | undefined, unit: string): string => {
  if (lo === undefined && hi === undefined) return '';
  if (lo !== undefined && hi !== undefined) return ` ${lo}..${hi} ${unit}`;
  return lo === undefined ? ` max ${hi} ${unit}` : ` min ${lo} ${unit}`;
};

function render(node: Node, depth: number): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ');
  const union = node.anyOf ?? node.oneOf;
  if (union) return [...new Set(union.map((n) => render(n, depth)))].join(' | ');
  const type = Array.isArray(node.type) ? node.type.join(' | ') : node.type;
  if (type === 'object' || node.properties) {
    if (depth >= DEPTH_MAX) return 'object';
    return renderObject(node, depth + 1);
  }
  if (type === 'array') {
    const item = node.items ? render(node.items, depth) : 'any';
    const limits = range(node.minItems, node.maxItems, 'items');
    return `array<${item}>${limits ? `(${limits.trim()})` : ''}`;
  }
  if (type === 'string') {
    const limits = range(node.minLength, node.maxLength, 'chars');
    const extra = [node.format, limits.trim()].filter(Boolean).join(', ');
    return extra ? `string(${extra})` : 'string';
  }
  if (type === 'integer' || type === 'number') {
    const limits = range(node.minimum, node.maximum, '').trim();
    return limits ? `${type}(${limits})` : type;
  }
  return type ?? 'any';
}

function renderObject(node: Node, depth: number): string {
  const required = new Set(node.required ?? []);
  const fields = Object.entries(node.properties ?? {}).map(
    ([name, child]) => `${name}${required.has(name) ? '' : '?'}: ${render(child, depth)}`,
  );
  return `{ ${fields.join(', ')} }`;
}

const kept = new WeakMap<object, string | null>();

/**
 * The body a route's zod schema accepts, as one line read off the schema itself: each field with its
 * type, its limits, and `?` where it may be left out. Null where the schema is no object (a body the
 * route reads itself), so a refusal never shows a shape the route does not hold.
 */
export function bodyShapeOf(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const hit = kept.get(schema);
  if (hit !== undefined) return hit;
  const json = z.toJSONSchema(schema as z.ZodType, {
    unrepresentable: 'any',
    io: 'input',
    reused: 'inline',
    cycles: 'ref',
  }) as Node;
  const shape = json.properties ? renderObject(json, 0) : null;
  const bounded = shape && shape.length > SHAPE_MAX ? `${shape.slice(0, SHAPE_MAX - 3)}...` : shape;
  kept.set(schema, bounded);
  return bounded;
}

/** The sentence a refusal appends: the accepted body, and what `?` means. */
export function acceptedBodySentence(schema: unknown): string | null {
  const shape = bodyShapeOf(schema);
  return shape === null ? null : `Accepted body (? marks an optional field): ${shape}`;
}
