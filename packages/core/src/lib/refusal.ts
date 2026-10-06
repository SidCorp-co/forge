import {
  PROBLEM_CONTENT_TYPE,
  type ProblemBody,
  REFUSAL_STATUS_ORDER,
  type Refusal,
  type RefusalEnvelope,
  type RefusalStatus,
  refusalTitle,
  refusalType,
} from '@forge/contracts/refusal';
import { refusalStatusOf } from '@forge/contracts/refusal-statuses';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type { ProblemBody, Refusal, RefusalEnvelope };

export class RefusalError extends Error {
  constructor(
    readonly refusals: readonly Refusal[],
    readonly fallbackCode: string,
  ) {
    super(refusals.map((r) => `${r.code}: ${r.detail}`).join('; '));
    this.name = 'RefusalError';
  }
}

export function jsonPointer(segments: readonly PropertyKey[]): string {
  return segments.map((s) => `/${String(s).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** Most relevant first by declared status; the order within one status is the caller's. */
function ranked(refusals: readonly Refusal[]): { refusal: Refusal; status: RefusalStatus }[] {
  return refusals
    .map((refusal, at) => ({ refusal, status: refusalStatusOf(refusal.code), at }))
    .sort(
      (a, b) =>
        REFUSAL_STATUS_ORDER.indexOf(a.status) - REFUSAL_STATUS_ORDER.indexOf(b.status) ||
        a.at - b.at,
    )
    .map(({ refusal, status }) => ({ refusal, status }));
}

/**
 * The body every refusal answers with, at both doors. The status is the leading refusal's declared
 * one (`@forge/contracts/refusal-statuses:refusalStatusOf`) unless the caller fixes it, as a failed
 * validator does with 400 and the sentence naming the valid shape.
 */
export function refusalEnvelope(
  refusals: readonly Refusal[],
  fallbackCode: string,
  fixed: { status?: RefusalStatus; detail?: string } = {},
): RefusalEnvelope {
  const ordered = ranked(refusals);
  const lead = ordered[0];
  if (!lead) throw new Error('refusalEnvelope: an empty list refuses nothing');
  const list = ordered.map((o) => o.refusal);
  const codes = [...new Set(list.map((r) => r.code))];
  const code = codes.length === 1 && codes[0] ? codes[0] : fallbackCode;
  const message = `refused, nothing written: ${list.map((r) => `${r.code} at ${r.path || '/'}: ${r.detail}`).join('; ')}`;
  return {
    type: refusalType(code),
    title: refusalTitle(code),
    status: fixed.status ?? lead.status,
    detail:
      fixed.detail ??
      (list.length === 1
        ? lead.refusal.detail
        : `${lead.refusal.detail} (${list.length - 1} more under error.refusals)`),
    code,
    message,
    error: { code, message, refusals: list },
  };
}

/**
 * An error that is not a rule refusal (401, a 404 from `rowIn`, a 5xx) in the same body: one row
 * at the request naming its sentence, so a client reading either place reads it.
 */
export function problemBody(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): ProblemBody {
  return {
    type: refusalType(code),
    title: refusalTitle(code),
    status,
    detail: message,
    code,
    message,
    ...(details === undefined ? {} : { details }),
    error: { code, message, refusals: [{ code, path: '', detail: message }] },
  };
}

/** A problem body served as `application/problem+json` under its own status. */
export function problem(c: Context, body: ProblemBody) {
  return c.json(body, body.status as ContentfulStatusCode, {
    'Content-Type': PROBLEM_CONTENT_TYPE,
  });
}

/**
 * A route's answer to refusals a service returned, under the module's fallback code when the
 * refusals carry more than one code.
 */
export function refused<C extends string>(
  c: Context,
  refusals: readonly Refusal[],
  fallbackCode: C,
) {
  return problem(c, refusalEnvelope(refusals, fallbackCode));
}

/**
 * A module's typed thrower: `const refuse = refuser<ReleaseRefusalCode>('RELEASE_REFUSED')`, then
 * `throw refuse('RELEASE_POOL_EMPTY', detail)`. Both doors answer it in the envelope.
 */
export function refuser<C extends string>(fallbackCode: C) {
  return (code: C, detail: string, path = ''): RefusalError =>
    new RefusalError([{ code, path, detail }], fallbackCode);
}

/** A thrown refusal, optionally naming one of its codes. */
export function isRefusal(err: unknown, code?: string): err is RefusalError {
  return (
    err instanceof RefusalError && (code === undefined || err.refusals.some((r) => r.code === code))
  );
}

/** The code a thrown refusal answers under, or null for anything else. */
export function refusalCodeOf(err: unknown): string | null {
  return err instanceof RefusalError
    ? refusalEnvelope(err.refusals, err.fallbackCode).error.code
    : null;
}

type Issue = { path: readonly PropertyKey[]; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isIssueList = (v: unknown): v is { issues: Issue[] } =>
  isRecord(v) &&
  Array.isArray(v.issues) &&
  v.issues.every((i) => isRecord(i) && Array.isArray(i.path) && typeof i.message === 'string');

const isRefusalRow = (v: unknown): v is Refusal =>
  isRecord(v) &&
  typeof v.code === 'string' &&
  typeof v.path === 'string' &&
  typeof v.detail === 'string';

function detailRefusals(
  code: string,
  at: readonly PropertyKey[],
  value: unknown,
  message: string,
): Refusal[] {
  const path = jsonPointer(at);
  if (value === undefined || value === null) return [{ code, path, detail: message }];
  if (typeof value === 'string') return [{ code, path, detail: value }];
  if (isIssueList(value)) {
    return value.issues.map((i) => ({
      code,
      path: jsonPointer([...at, ...i.path]),
      detail: i.message,
    }));
  }
  if (Array.isArray(value)) {
    if (value.every(isRefusalRow)) return value;
    if (value.every((v) => typeof v === 'string')) {
      return value.map((detail) => ({ code, path, detail }));
    }
  }
  if (isRecord(value)) {
    if (Array.isArray(value.refusals) && value.refusals.every(isRefusalRow)) return value.refusals;
    const rows = Object.entries(value).flatMap(([key, v]) =>
      detailRefusals(code, [...at, key], v, message),
    );
    if (rows.length > 0) return rows;
  }
  return [{ code, path, detail: `${message}: ${JSON.stringify(value)}` }];
}

/**
 * What a request-shape refusal (400) names, in the refusal rows every other refusal uses: a zod
 * error's issues at their JSON pointers, a field map at its fields, a sentence at the request.
 */
export function requestRefusals(code: string, message: string, details: unknown): Refusal[] {
  const rows = detailRefusals(code, [], details, message);
  return rows.length > 0 ? rows : [{ code, path: '', detail: message }];
}
