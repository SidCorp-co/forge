import { redactQueryParams } from '@forge/observability';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { activeChildUnderTerminalRun } from '../lib/db-errors.js';
import { reportFailure } from '../lib/error-tracking.js';
import { getLogger } from '../lib/logger.js';
import {
  problem,
  problemBody,
  RefusalError,
  refusalEnvelope,
  requestRefusals,
} from '../lib/refusal.js';
import type { RequestIdVars } from './request-id.js';

type ErrorBody = { code: string; message: string; details?: unknown };

/** An error that is not a refusal, in the one problem body (`lib/refusal.ts:problemBody`). */
function httpProblem(c: Context, status: ContentfulStatusCode, body: ErrorBody) {
  return problem(c, problemBody(status, body.code, body.message, body.details));
}

const isProd = process.env.NODE_ENV === 'production';

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

function extractCause(cause: unknown): {
  code?: string;
  details?: unknown;
  wwwAuthenticate?: string;
} {
  // Reject Error instances (Node fs `ENOENT`, pg `23505`, libuv `EACCES`…).
  // Their `.code` would otherwise be propagated into the response body's
  // `code` field, leaking implementation detail and bypassing the documented
  // enum (BAD_REQUEST, UNAUTHENTICATED, NOT_FOUND, …). Callers wanting to
  // surface a custom code must pass a plain `cause` object.
  if (cause && typeof cause === 'object' && !(cause instanceof Error)) {
    const obj = cause as Record<string, unknown>;
    const out: { code?: string; details?: unknown; wwwAuthenticate?: string } = {};
    if (typeof obj.code === 'string') out.code = obj.code;
    if ('details' in obj) out.details = obj.details;
    if (typeof obj.wwwAuthenticate === 'string') out.wwwAuthenticate = obj.wwwAuthenticate;
    return out;
  }
  return {};
}

export const errorHandler: ErrorHandler<{ Variables: RequestIdVars }> = (err, c) => {
  const log = getLogger(c);

  const orphan = activeChildUnderTerminalRun(err);
  const refusal =
    orphan === null
      ? err
      : new RefusalError(
          [{ code: 'ACTIVE_CHILD_UNDER_TERMINAL_RUN', path: '', detail: orphan }],
          'ACTIVE_CHILD_UNDER_TERMINAL_RUN',
        );
  if (refusal instanceof RefusalError) {
    const envelope = refusalEnvelope(refusal.refusals, refusal.fallbackCode);
    log.warn(
      { status: envelope.status, code: envelope.error.code, err: err.message },
      'http.error',
    );
    return problem(c, envelope);
  }

  if (err instanceof HTTPException) {
    const status = err.status;
    const { code: causeCode, details, wwwAuthenticate } = extractCause(err.cause);
    const code = causeCode ?? statusToCode(status);
    const message = err.message || statusToCode(status);

    if (status === 400) {
      const envelope = refusalEnvelope(requestRefusals(code, message, details), code, {
        status: 400,
        ...(message === 'Invalid input' ? {} : { detail: message }),
      });
      log.warn({ status, code, err: err.message }, 'http.error');
      return problem(c, envelope);
    }

    const body: ErrorBody = { code, message };
    if (details !== undefined) body.details = details;

    const logPayload = { status, code: body.code, err: err.message };
    if (status >= 500) log.error(logPayload, 'http.error');
    else log.warn(logPayload, 'http.error');

    // 5xx HTTPExceptions still represent server-side failures we want to
    // see in Sentry; 4xx are expected client errors and stay out.
    if (status >= 500) reportRequestFailure(err, c, body.code);

    if (status === 401 && wwwAuthenticate) {
      c.header('WWW-Authenticate', wwwAuthenticate);
    }

    return httpProblem(c, status, body);
  }

  const body: ErrorBody = {
    code: 'INTERNAL_ERROR',
    message: 'Internal Server Error',
  };
  if (!isProd && err instanceof Error) {
    body.details = redactQueryParams(
      { name: err.name, message: err.message, stack: err.stack },
      err,
    );
  }

  log.error({ err }, 'http.unhandled');
  reportRequestFailure(err, c, 'INTERNAL_ERROR');
  return httpProblem(c, 500, body);
};

function reportRequestFailure(
  err: unknown,
  c: Context<{ Variables: RequestIdVars }>,
  code: string,
): void {
  const requestId = c.get('requestId');
  reportFailure(err, {
    tags: {
      'http.method': c.req.method,
      'http.path': c.req.path,
      'error.code': code,
      ...(requestId ? { 'request.id': requestId } : {}),
    },
  });
}

export const notFoundHandler: NotFoundHandler<{ Variables: RequestIdVars }> = (c: Context) => {
  return httpProblem(c, 404, {
    code: 'NOT_FOUND',
    message: `Not Found: ${c.req.method} ${c.req.path}`,
  });
};
