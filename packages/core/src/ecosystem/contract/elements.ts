import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { openApiElements } from './openapi-diff.js';
import { jsonSchemaElements, toolsOf } from './schema-diff.js';

export const INDEXED_TYPES = ['openapi', 'mcp-tools', 'json-schema'] as const;
export type IndexedType = (typeof INDEXED_TYPES)[number];

export const isIndexed = (type: string): type is IndexedType =>
  (INDEXED_TYPES as readonly string[]).includes(type);

export interface ContractExample {
  element: string;
  direction: 'request' | 'response' | 'event' | 'tool-input' | 'tool-output';
  status?: number | undefined;
  payload?: unknown;
}

export interface ContractIndex {
  type: IndexedType;
  elements: ReadonlySet<string>;
  document: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function elementsOf(type: IndexedType, document: unknown): string[] {
  if (type === 'openapi') return openApiElements(document);
  if (type === 'mcp-tools') return [...(toolsOf(document)?.keys() ?? [])];
  return jsonSchemaElements(document);
}

export function indexContract(type: IndexedType, document: unknown): ContractIndex {
  return { type, document, elements: new Set(elementsOf(type, document)) };
}

const at = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((node, k) => (isObject(node) ? node[k] : undefined), v);

function openApiSchema(doc: unknown, ex: ContractExample): unknown | string {
  const [method = '', ...rest] = ex.element.split(' ');
  const op = at(doc, 'paths', rest.join(' '), method.toLowerCase());
  if (ex.direction === 'request') {
    return (
      at(op, 'requestBody', 'content', 'application/json', 'schema') ??
      `${ex.element} takes no JSON request body in this version`
    );
  }
  if (ex.direction === 'response') {
    const key = ex.status === undefined ? 'default' : String(ex.status);
    return (
      at(op, 'responses', key, 'content', 'application/json', 'schema') ??
      `${ex.element} declares no JSON response schema for ${key} in this version, so a response example has nothing to be checked against`
    );
  }
  return `an OpenAPI element takes a request or response example, not ${ex.direction}`;
}

function schemaFor(index: ContractIndex, ex: ContractExample): unknown | string {
  if (index.type === 'openapi') return openApiSchema(index.document, ex);
  if (index.type === 'mcp-tools') {
    if (ex.direction !== 'tool-input') {
      return `the tools contract describes each tool's input, so a ${ex.direction} example has nothing to be checked against`;
    }
    return toolsOf(index.document)?.get(ex.element)?.inputSchema ?? `${ex.element} is not a tool`;
  }
  if (ex.element === '#') return index.document;
  const def = /^#\/\$defs\/(.+)$/.exec(ex.element)?.[1];
  return (
    (def && at(index.document, '$defs', def.replace(/~1/g, '/').replace(/~0/g, '~'))) ??
    `${ex.element} is not a definition`
  );
}

const ajv = new Ajv2020({ strict: false, allErrors: false, validateSchema: false });
addFormats(ajv);

// cm:why an example the cited schema cannot be compiled for is refused, never waved through: the check is fail-closed like every content check on the channel
export function exampleProblem(index: ContractIndex, ex: ContractExample): string | null {
  if (!index.elements.has(ex.element)) return `${ex.element} is not an element of this version`;
  const schema = schemaFor(index, ex);
  if (typeof schema === 'string') return schema;
  if (typeof schema !== 'boolean' && !isObject(schema))
    return `${ex.element} has no schema to check against`;
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    return `the schema of ${ex.element} could not be compiled (${err instanceof Error ? err.message : String(err)})`;
  }
  const ok = validate(ex.payload);
  const e = validate.errors?.[0];
  ajv.removeSchema(schema as object);
  if (ok) return null;
  return `the payload does not match the schema of ${ex.element}: ${e ? `${e.instancePath || '/'} ${e.message ?? 'is invalid'}` : 'invalid'}`;
}
