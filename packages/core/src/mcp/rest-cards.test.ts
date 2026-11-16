// @direct-test-of packages/core/src/mcp/rest-cards.ts
// ISS-1251: a REST door's card names a write the published contract serves, and its example is a
// body that write accepts as written, so an agent copying it is not refused.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CONTRACTS_DIR } from '../api-contract/routes.js';
import { AFFORDANCE_CARDS } from '../prompt/index.js';
import { REST_CARDS } from './rest-cards.js';

type Schema = Record<string, unknown>;
type OpenApi = {
  paths: Record<
    string,
    Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>
  >;
  components?: Schema;
};

const document = JSON.parse(
  readFileSync(resolve(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
) as OpenApi;

/** The operation a door id names: `POST /api/issues/:id/merge` → paths['/api/issues/{id}/merge'].post. */
const operationOf = (id: string) => {
  const [method, template] = id.split(' ') as [string, string];
  const path = template.replace(/:([A-Za-z]+)/g, '{$1}');
  return document.paths[path]?.[method.toLowerCase()];
};

describe('the REST doors’ capability cards (ISS-1251)', () => {
  it('each names a write this build serves, once, and none repeats an orientation card', () => {
    const ids = REST_CARDS.map((c) => c.id);
    expect(ids.filter((id) => !operationOf(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    const oriented = new Set(AFFORDANCE_CARDS.map((c) => c.id));
    expect(ids.filter((id) => oriented.has(id))).toEqual([]);
  });

  it('carries an example its door’s body accepts as written', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const refused: string[] = [];
    for (const c of REST_CARDS) {
      if (c.example === undefined) continue;
      const body = operationOf(c.id)?.requestBody;
      const schema = body ? Object.values(body.content)[0]?.schema : undefined;
      if (!schema) {
        // a door taking no JSON body is shown with none
        if (Object.keys(c.example).length > 0) refused.push(`${c.id}: takes no body`);
        continue;
      }
      if (!ajv.validate({ ...schema, components: document.components }, c.example)) {
        refused.push(`${c.id}: ${ajv.errorsText(ajv.errors)}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it('refuses an example its door would refuse, naming the field', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const schema = Object.values(
      operationOf('PUT /api/issues/:id/criteria')?.requestBody?.content ?? {},
    )[0]?.schema as Schema;
    expect(ajv.validate({ ...schema, components: document.components }, { criteria: 'x' })).toBe(
      false,
    );
    expect(ajv.errorsText(ajv.errors)).toContain('criteria');
  });
});
