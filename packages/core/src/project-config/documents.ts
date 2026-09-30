import type { z } from 'zod';
import type { ConfigRefusal, ConfigRefusalCode } from './rules.js';

export type ApiRefusalCode =
  | ConfigRefusalCode
  | 'SCHEMA_VIOLATION'
  | 'TESTING_PROFILE_ID_MISMATCH'
  | 'TESTING_PROFILE_IN_USE';

export interface ApiRefusal extends Omit<ConfigRefusal, 'code'> {
  code: ApiRefusalCode;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusals: ApiRefusal[] };

export function pointer(segments: readonly PropertyKey[]): string {
  return segments.map((s) => `/${String(s).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function issueRefusals(issue: z.core.$ZodIssue): ApiRefusal[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      code: 'UNKNOWN_KEY',
      path: pointer([...issue.path, key]),
      detail: `"${key}" is not a key of this document; version 1 refuses keys it does not define.`,
    }));
  }
  return [{ code: 'SCHEMA_VIOLATION', path: pointer(issue.path), detail: issue.message }];
}

export function parseVersionedDocument<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  what: string,
): Parsed<T> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'SCHEMA_VIOLATION',
          path: '',
          detail: `the ${what} document must be a JSON object`,
        },
      ],
    };
  }
  if ('version' in raw && raw.version !== 1) {
    return {
      ok: false,
      refusals: [
        {
          code: 'VERSION_UNSUPPORTED',
          path: '/version',
          detail: `version ${JSON.stringify(raw.version)} is not supported; core reads ${what} documents at version 1 only, and moving versions is a migration.`,
        },
      ],
    };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, refusals: result.error.issues.flatMap(issueRefusals) };
}

export type WriteEnvelope = { baseRevision: number | null; document: unknown };

export function parseWriteEnvelope(raw: unknown):
  | { ok: true; value: WriteEnvelope }
  | {
      ok: false;
      message: string;
    } {
  if (!isRecord(raw)) return { ok: false, message: 'the body must be { baseRevision, document }' };
  const extra = Object.keys(raw).filter((k) => k !== 'baseRevision' && k !== 'document');
  if (extra.length > 0) {
    return {
      ok: false,
      message: `unknown body key(s) ${extra.join(', ')}; the body is { baseRevision, document }`,
    };
  }
  if (!('baseRevision' in raw)) {
    return {
      ok: false,
      message:
        'baseRevision is required: the revision this write was read at, or null for a first write',
    };
  }
  const base = raw.baseRevision;
  if (base !== null && !(typeof base === 'number' && Number.isInteger(base) && base >= 1)) {
    return {
      ok: false,
      message: 'baseRevision must be a positive integer, or null for a first write',
    };
  }
  if (!('document' in raw)) return { ok: false, message: 'document is required' };
  return { ok: true, value: { baseRevision: base, document: raw.document } };
}

export function staleBase(baseRevision: number | null, storedRevision: number | null): ApiRefusal {
  const stored = storedRevision === null ? 'nothing (never written)' : `revision ${storedRevision}`;
  const base = baseRevision === null ? 'null (a first write)' : `revision ${baseRevision}`;
  return {
    code: 'STALE_BASE',
    path: '/baseRevision',
    detail: `this write was based on ${base}, and the store holds ${stored}. Read it again and reapply the change; nothing was written.`,
  };
}

export function parseSecretRef(ref: string): { scope: string; name: string } | null {
  const m = /^secret:\/\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/.exec(ref);
  return m?.[1] && m[2] ? { scope: m[1], name: m[2] } : null;
}

export const secretRefOf = (scope: string, name: string) => `secret://${scope}/${name}`;
