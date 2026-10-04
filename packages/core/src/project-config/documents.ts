import type { ProjectConfigRefusalCode } from '@forge/contracts/project-config';
import type { z } from 'zod';
import { jsonPointer as pointer } from '../lib/refusal.js';
import type { ConfigRefusal } from './rules.js';
import { TOOL_PATTERN } from './schema.js';

const BINDING_ROLLBACK_MOVED =
  "rollback is not a binding's: how a release is undone is the project document's `rollback.strategy` (`PUT /api/projects/:id/config`).";

export interface ApiRefusal extends Omit<ConfigRefusal, 'code'> {
  code: ProjectConfigRefusalCode;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusals: ApiRefusal[] };

export { pointer };

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function issueRefusals(issue: z.core.$ZodIssue, version: unknown): ApiRefusal[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key): ApiRefusal => {
      if (key === 'rollback' && issue.path[0] === 'target') {
        return {
          code: 'BINDING_ROLLBACK_MOVED',
          path: pointer([...issue.path, key]),
          detail: BINDING_ROLLBACK_MOVED,
        };
      }
      return {
        code: 'UNKNOWN_KEY',
        path: pointer([...issue.path, key]),
        detail: `"${key}" is not a key of this document; ${
          typeof version === 'number' ? `version ${version}` : 'a version'
        } refuses keys it does not define.`,
      };
    });
  }
  if (issue.code === 'invalid_format' && issue.pattern === String(TOOL_PATTERN)) {
    return [
      {
        code: 'TOOL_PATTERN_INVALID',
        path: pointer(issue.path),
        detail:
          'not a tool pattern the runner can deny: a built-in tool name (`Bash`), optionally with a specifier (`Bash(git push:*)`), or an MCP server or tool (`mcp__forge__forge_coolify_deploy`, `mcp__playwright__*`).',
      },
    ];
  }
  return [{ code: 'SCHEMA_VIOLATION', path: pointer(issue.path), detail: issue.message }];
}

export function parseVersionedDocument<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  what: string,
  versions: readonly number[] = [1],
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
  if ('version' in raw && !versions.includes(raw.version as number)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'VERSION_UNSUPPORTED',
          path: '/version',
          detail: `version ${JSON.stringify(raw.version)} is not supported; core reads ${what} documents at version ${versions.join(' or ')} only, and moving versions is a migration.`,
        },
      ],
    };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, refusals: result.error.issues.flatMap((i) => issueRefusals(i, raw.version)) };
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
