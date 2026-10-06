type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pointer = (parts: readonly string[]) =>
  `/${parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// the kin-openapi loader oasdiff runs answers "cannot unmarshal array into openapi3.SchemaBis" and no place; this walks every place the OpenAPI document holds a Schema Object so the refusal can name the one that holds something else
export function misplacedSchema(doc: unknown): string | null {
  if (!isObject(doc)) return null;
  const booleanSchemas = typeof doc.openapi === 'string' && doc.openapi.startsWith('3.1');
  let found: string | null = null;

  const schema = (v: unknown, at: string[]) => {
    if (found) return;
    if (!isObject(v)) {
      if (!(booleanSchemas && typeof v === 'boolean')) found = pointer(at);
      return;
    }
    if ('$ref' in v) return;
    for (const key of ['items', 'not']) if (key in v) schema(v[key], [...at, key]);
    if ('additionalProperties' in v && typeof v.additionalProperties !== 'boolean') {
      schema(v.additionalProperties, [...at, 'additionalProperties']);
    }
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      const list = v[key];
      if (Array.isArray(list))
        for (const [i, s] of list.entries()) schema(s, [...at, key, String(i)]);
      else if (key in v) found ??= pointer([...at, key]);
    }
    if (isObject(v.properties)) {
      for (const [name, s] of Object.entries(v.properties)) schema(s, [...at, 'properties', name]);
    }
  };
  const content = (v: unknown, at: string[]) => {
    if (!isObject(v)) return;
    for (const [type, media] of Object.entries(v)) {
      if (isObject(media) && 'schema' in media) schema(media.schema, [...at, type, 'schema']);
    }
  };
  const holder = (v: unknown, at: string[]) => {
    if (!isObject(v) || '$ref' in v) return;
    if ('schema' in v) schema(v.schema, [...at, 'schema']);
    content(v.content, [...at, 'content']);
    if (isObject(v.headers)) {
      for (const [name, h] of Object.entries(v.headers)) holder(h, [...at, 'headers', name]);
    }
  };
  const each = (v: unknown, at: string[], visit: (x: unknown, at: string[]) => void) => {
    if (Array.isArray(v)) for (const [i, x] of v.entries()) visit(x, [...at, String(i)]);
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) visit(x, [...at, k]);
  };

  const components = isObject(doc.components) ? doc.components : {};
  each(components.schemas, ['components', 'schemas'], schema);
  for (const kind of ['parameters', 'requestBodies', 'responses', 'headers']) {
    each(components[kind], ['components', kind], holder);
  }
  if (isObject(doc.paths)) {
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!isObject(item)) continue;
      each(item.parameters, ['paths', path, 'parameters'], holder);
      for (const method of METHODS) {
        const op = item[method];
        if (!isObject(op)) continue;
        const at = ['paths', path, method];
        each(op.parameters, [...at, 'parameters'], holder);
        holder(op.requestBody, [...at, 'requestBody']);
        each(op.responses, [...at, 'responses'], holder);
      }
    }
  }
  return found;
}
