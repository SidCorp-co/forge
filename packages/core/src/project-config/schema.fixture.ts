import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';
import type { z } from 'zod';
import { type ProjectConfigSchemaName, projectConfigJsonSchemas, schemaId } from './json-schema.js';
import {
  bindingDocumentSchema,
  environmentStateSchema,
  policyDocumentSchema,
  projectDocumentSchema,
  testingProfileSchema,
} from './schema.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
export type Doc = Record<string, any>;

const FIXTURES = new URL('./fixtures/', import.meta.url);
export const read = (rel: string): Doc => JSON.parse(readFileSync(new URL(rel, FIXTURES), 'utf8'));
export const allFixtures = (): string[] =>
  ['examples', 'sim-forge-dev'].flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, FIXTURES))
      .filter((f) => f.endsWith('.json'))
      .map((f) => `${dir}/${f}`),
  );
export const clone = (d: Doc): Doc => structuredClone(d);

const ZOD: Record<ProjectConfigSchemaName, z.ZodType> = {
  project: projectDocumentSchema,
  policy: policyDocumentSchema,
  'testing-profile': testingProfileSchema,
  binding: bindingDocumentSchema,
  'environment-state': environmentStateSchema,
};

export const NAMES = Object.keys(ZOD) as ProjectConfigSchemaName[];

export const nameOf = (doc: Doc): ProjectConfigSchemaName => {
  if (doc.$schema === undefined) return 'environment-state';
  const hit = NAMES.find((n) => schemaId(n) === doc.$schema);
  if (!hit) throw new Error(`fixture names no known schema: ${doc.$schema}`);
  return hit;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
export const AJV = Object.fromEntries(
  NAMES.map((n) => [n, ajv.compile(projectConfigJsonSchemas[n])]),
) as Record<ProjectConfigSchemaName, ReturnType<typeof ajv.compile>>;

type Issue = { path: string; code: string; keys?: string[] };

function flatten(issues: readonly z.core.$ZodIssue[], base: PropertyKey[] = []): Issue[] {
  return issues.flatMap((i) => {
    const path = [...base, ...i.path];
    const here: Issue = {
      path: path.map((p) => `/${String(p)}`).join(''),
      code: i.code,
      ...(i.code === 'unrecognized_keys' ? { keys: i.keys } : {}),
    };
    if (i.code === 'invalid_union') return [here, ...i.errors.flatMap((e) => flatten(e, path))];
    return [here];
  });
}

export function verdict(name: ProjectConfigSchemaName, doc: Doc) {
  const parsed = ZOD[name].safeParse(doc);
  const validate = AJV[name];
  const ajvOk = validate(doc) as boolean;
  return {
    zodOk: parsed.success,
    ajvOk,
    issues: parsed.success ? [] : flatten(parsed.error.issues),
    ajvPaths: ajvOk ? [] : (validate.errors ?? []).map((e) => e.instancePath),
  };
}

export function expectRefused(
  name: ProjectConfigSchemaName,
  doc: Doc,
  want: { path: string; code?: string; key?: string },
) {
  const v = verdict(name, doc);
  expect(v.zodOk, 'zod accepted a planted document').toBe(false);
  expect(v.ajvOk, 'the emitted JSON Schema accepted a planted document').toBe(false);
  const hit = v.issues.find(
    (i) =>
      i.path === want.path &&
      (want.code === undefined || i.code === want.code) &&
      (want.key === undefined || i.keys?.includes(want.key)),
  );
  expect(hit, `no issue at ${want.path}; got ${JSON.stringify(v.issues)}`).toBeDefined();
}

export function expectAccepted(name: ProjectConfigSchemaName, doc: Doc) {
  const v = verdict(name, doc);
  expect(v.issues).toEqual([]);
  expect(v.ajvPaths).toEqual([]);
}
