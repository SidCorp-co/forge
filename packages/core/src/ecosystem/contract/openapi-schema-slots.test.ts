import { describe, expect, it } from 'vitest';
import { misplacedSchema } from './openapi-schema-slots.js';

const spec = (schema: unknown, openapi = '3.0.3') => ({
  openapi,
  paths: {
    '/api/v1/platforms/{id}': {
      get: { responses: { '200': { content: { 'application/json': { schema } } } } },
    },
  },
});
const AT = '/paths/~1api~1v1~1platforms~1{id}/get/responses/200/content/application~1json/schema';

describe('misplacedSchema', () => {
  it('names the items holding [] where a PHP YAML-to-JSON conversion wrote an empty schema', () => {
    const doc = spec({
      properties: {
        data: { oneOf: [{ type: 'object' }, { type: 'array', maxItems: 0, items: [] }] },
      },
    });
    expect(misplacedSchema(doc)).toBe(`${AT}/properties/data/oneOf/1/items`);
  });

  it('finds nothing in the same document once the empty schema is {}', () => {
    const doc = spec({
      properties: { data: { oneOf: [{ type: 'object' }, { type: 'array', items: {} }] } },
    });
    expect(misplacedSchema(doc)).toBeNull();
  });

  it('reads components, parameters, request bodies and headers, and does not follow a $ref', () => {
    expect(
      misplacedSchema({
        openapi: '3.0.3',
        components: { schemas: { A: { properties: { x: 'string' } } } },
      }),
    ).toBe('/components/schemas/A/properties/x');
    expect(
      misplacedSchema({
        openapi: '3.0.3',
        paths: { '/a': { post: { parameters: [{ name: 'q', schema: [] }] } } },
      }),
    ).toBe('/paths/~1a/post/parameters/0/schema');
    expect(
      misplacedSchema({
        openapi: '3.0.3',
        paths: { '/a': { post: { requestBody: { content: { 'text/plain': { schema: 7 } } } } } },
      }),
    ).toBe('/paths/~1a/post/requestBody/content/text~1plain/schema');
    expect(
      misplacedSchema({ openapi: '3.0.3', components: { headers: { H: { schema: [] } } } }),
    ).toBe('/components/headers/H/schema');
    expect(misplacedSchema(spec({ $ref: '#/components/schemas/A' }))).toBeNull();
  });

  it('takes additionalProperties: true everywhere, and a boolean schema only on 3.1', () => {
    expect(misplacedSchema(spec({ additionalProperties: true }))).toBeNull();
    expect(misplacedSchema(spec({ items: true }))).toBe(`${AT}/items`);
    expect(misplacedSchema(spec({ items: true }, '3.1.0'))).toBeNull();
  });

  it('answers null for a document that is not an object', () => {
    expect(misplacedSchema([])).toBeNull();
    expect(misplacedSchema(null)).toBeNull();
  });
});
