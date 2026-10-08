import { redactedMessage, redactQueryParams } from '@forge/observability';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getLogger } from '../logger.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import type { RequestIdVars } from './request-id.js';

type ErrorBody = { code: string; message: string; details?: unknown };

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

/**
 * What Sentry is told for a 5xx `HTTPException` that stands in for a different failure.
 *
 * ISS-1252: a handler that catches what its dependency threw and answers with a fixed refusal gives
 * the caller the refusal and Sentry the refusal too, so every such failure arrives as one event and
 * one group whatever broke. The caught error and what identifies the call are held here, beside
 * the exception and not on it: `cause` and `details` reach the response body, and this is meant to
 * stay on the server.
 */
export interface SentryCause {
  /** The error that was caught; sent in place of the exception that replaced it. */
  error: unknown;
  /** Tags naming what the failing call was, set on the event beside the request's own. */
  tags: Record<string, string>;
}

const sentryCauses = new WeakMap<HTTPException, SentryCause>();

/** Hands `exception`'s capture the error it replaces, and returns `exception` for `throw`. */
export function withSentryCause(exception: HTTPException, cause: SentryCause): HTTPException {
  sentryCauses.set(exception, {
    error: cause.error instanceof Error ? cause.error : notAnError(cause.error),
    tags: cause.tags,
  });
  return exception;
}

/** A thrown string or object has no stack and no name to tell it from another; this says what it was. */
function notAnError(thrown: unknown): Error {
  return new Error(`a handler threw a value that is not an Error (${typeof thrown})`, {
    cause: thrown,
  });
}

export const errorHandler: ErrorHandler<{ Variables: RequestIdVars }> = (err, c) => {
  const log = getLogger(c);

  if (err instanceof HTTPException) {
    const status = err.status;
    const { code: causeCode, details, wwwAuthenticate } = extractCause(err.cause);
    const body: ErrorBody = {
      code: causeCode ?? statusToCode(status),
      message: err.message || statusToCode(status),
    };
    if (details !== undefined) body.details = details;

    const logPayload = { status, code: body.code, err: redactedMessage(err) };
    if (status >= 500) log.error(logPayload, 'http.error');
    else log.warn(logPayload, 'http.error');

    // 5xx HTTPExceptions still represent server-side failures we want to
    // see in Sentry; 4xx are expected client errors and stay out.
    if (isSentryEnabled() && status >= 500) {
      captureToSentry(err, c, body.code);
    }

    if (status === 401 && wwwAuthenticate) {
      c.header('WWW-Authenticate', wwwAuthenticate);
    }

    return c.json(redactQueryParams(body, err), status);
  }

  const body: ErrorBody = {
    code: 'INTERNAL_ERROR',
    message: 'Internal Server Error',
  };
  if (!isProd && err instanceof Error) {
    body.details = { name: err.name, message: err.message, stack: err.stack };
  }

  log.error({ err }, 'http.unhandled');
  if (isSentryEnabled()) {
    captureToSentry(err, c, 'INTERNAL_ERROR');
  }
  return c.json(redactQueryParams(body, err), 500);
};

function captureToSentry(
  err: unknown,
  c: Context<{ Variables: RequestIdVars }>,
  code: string,
): void {
  const carried = err instanceof HTTPException ? sentryCauses.get(err) : undefined;
  Sentry.withScope((scope) => {
    if (carried) scope.setTags(carried.tags);
    scope.setTag('http.method', c.req.method);
    scope.setTag('http.path', c.req.path);
    scope.setTag('error.code', code);
    const requestId = c.get('requestId');
    if (requestId) scope.setTag('request.id', requestId);
    Sentry.captureException(carried ? carried.error : err);
  });
}

export const notFoundHandler: NotFoundHandler<{ Variables: RequestIdVars }> = (c: Context) => {
  return c.json<ErrorBody>(
    { code: 'NOT_FOUND', message: `Not Found: ${c.req.method} ${c.req.path}` },
    404,
  );
};
