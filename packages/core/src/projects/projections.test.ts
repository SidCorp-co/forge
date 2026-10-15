/**
 * ISS-1389 — no project read hands a reader a credential it did not ask for.
 *
 * `GET /api/projects` once answered every project's API key in every listing, so one listing put
 * several keys into an agent's session. Three walks hold the line: every projection in
 * `projections.ts`, every response schema in `routes-reference.ts`, and every source line of the
 * module that reads a projects column. Each refuses a field named like a secret, by its JSON name
 * and by the column it reads, and names where it found it. `ROTATED_API_KEY` and
 * `rotatedApiKeySchema` are the one exemption: rotation is the route whose job is to show the key.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { projects } from '../db/schema.js';
import * as projections from './projections.js';
import * as reference from './routes-reference.js';

/** A name ending in a credential noun: `apiKey`, `webhook_secret`, `accessToken`; a count such as `maxResumeTokens` is not one. */
const SECRET_NAME = /(api_?key|token|secret|password)$/i;

const SERVES_THE_KEY = new Set(['ROTATED_API_KEY', 'rotatedApiKeySchema']);

const HERE = dirname(fileURLToPath(import.meta.url));

/** The column a projection field reads, by its database name where it is a column at all. */
function columnName(value: unknown): string | null {
  const name = (value as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : null;
}

/** Every field of a projection that names a secret, by its key or by the column behind it. */
function secretFieldsOf(projection: Record<string, unknown>): string[] {
  return Object.entries(projection)
    .filter(([key, value]) => SECRET_NAME.test(key) || SECRET_NAME.test(columnName(value) ?? ''))
    .map(([key, value]) => `${key} (${columnName(value) ?? 'no column'})`);
}

type Def = {
  type: string;
  shape?: Record<string, ZodType>;
  element?: ZodType;
  innerType?: ZodType;
  options?: ZodType[];
  in?: ZodType;
  out?: ZodType;
};

/** Every path under a response schema whose last segment names a secret. */
function secretPathsOf(schema: ZodType, at: string, seen = new Set<ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  const below = (child: ZodType | undefined, path: string) =>
    child ? secretPathsOf(child, path, seen) : [];
  switch (def.type) {
    case 'object':
      return Object.entries(def.shape ?? {}).flatMap(([key, child]) => [
        ...(SECRET_NAME.test(key) ? [`${at}.${key}`] : []),
        ...below(child, `${at}.${key}`),
      ]);
    case 'array':
      return below(def.element, `${at}[]`);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
      return below(def.innerType, at);
    case 'union':
      return (def.options ?? []).flatMap((option) => below(option, at));
    case 'pipe':
      return [...below(def.in, at), ...below(def.out, at)];
    default:
      return [];
  }
}

const isZodSchema = (value: unknown): value is ZodType =>
  typeof value === 'object' && value !== null && '_zod' in value;

describe('projects projections name no secret', () => {
  const entries = Object.entries(projections).filter(([name]) => !SERVES_THE_KEY.has(name));

  it('walks every projection the module exports', () => {
    expect(entries.map(([name]) => name).sort()).toEqual([
      'ARCHIVED_PROJECT',
      'CREATED_PROJECT',
      'PATCHED_PROJECT',
      'PROJECT_DETAIL',
      'PROJECT_LIST',
    ]);
  });

  it.each(entries)('%s carries no field named like a secret', (name, projection) => {
    expect(secretFieldsOf(projection as Record<string, unknown>), name).toEqual([]);
  });

  it('refuses a planted apiKey by name, and one aliased under an innocent key by its column', () => {
    expect(secretFieldsOf({ ...projections.PROJECT_LIST, apiKey: projects.apiKey })).toEqual([
      'apiKey (api_key)',
    ]);
    expect(
      secretFieldsOf({ ...projections.PATCHED_PROJECT, hook: projects.webhookSecret }),
    ).toEqual(['hook (webhook_secret)']);
  });

  it('the rotation answer is the one projection that reads the key', () => {
    expect(secretFieldsOf(projections.ROTATED_API_KEY)).toEqual(['apiKey (api_key)']);
  });

  it('the pattern reaches every credential column the projects table holds', () => {
    const credentials = Object.values(getTableColumns(projects))
      .map((column) => column.name)
      .filter((name) => SECRET_NAME.test(name))
      .sort();
    expect(credentials).toEqual(['api_key', 'webhook_secret']);
  });
});

describe('projects response schemas name no secret', () => {
  const schemas = Object.entries(reference).flatMap(
    ([name, value]): Array<[string, ZodType]> =>
      isZodSchema(value) && !SERVES_THE_KEY.has(name) ? [[name, value]] : [],
  );

  it('finds the response schemas to walk', () => {
    const names = schemas.map(([name]) => name);
    for (const expected of [
      'createdProjectSchema',
      'projectListSchema',
      'projectDetailSchema',
      'patchedProjectSchema',
      'archivedProjectSchema',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(schemas)('%s answers no field named like a secret', (name, schema) => {
    expect(secretPathsOf(schema, name)).toEqual([]);
  });

  it('refuses a planted key in a listing row, naming its path', () => {
    const planted = reference.projectListSchema.element.extend({
      apiKey: reference.rotatedApiKeySchema.shape.apiKey,
    });
    expect(secretPathsOf(planted, 'projectListSchema[]')).toEqual(['projectListSchema[].apiKey']);
  });
});

/** Every `projects.<column>` a secret names, read anywhere in the module but `projections.ts`. */
function secretReadsIn(file: string, source: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(/\bprojects\.(\w+)/g)]
        .filter((match) => SECRET_NAME.test(match[1] ?? ''))
        .map((match) => `${file}:${index + 1} reads projects.${match[1]}`),
    );
}

describe('the projects module reads a secret column through projections.ts alone', () => {
  const sources = [
    ...readdirSync(HERE)
      .filter(
        (name) => name.endsWith('.ts') && !name.includes('.test.') && name !== 'projections.ts',
      )
      .map((name) => [`projects/${name}`, join(HERE, name)] as const),
    ['mcp/tools/forge-projects.ts', join(HERE, '..', 'mcp', 'tools', 'forge-projects.ts')] as const,
  ];

  it('no route, service or tool of the module names a secret column', () => {
    const reads = sources.flatMap(([file, path]) =>
      secretReadsIn(file, readFileSync(path, 'utf8')),
    );
    expect(reads).toEqual([]);
  });

  it('refuses a planted read naming file and line', () => {
    expect(secretReadsIn('projects/routes.ts', 'const a = 1;\n  apiKey: projects.apiKey,')).toEqual(
      ['projects/routes.ts:2 reads projects.apiKey'],
    );
  });
});
