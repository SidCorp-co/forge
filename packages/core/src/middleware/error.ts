import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { StatusCode } from 'hono/utils/http-status';
import { getLogger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
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

    const logPayload = { status, code: body.code, err: err.message };
    if (status >= 500) log.error(logPayload, 'http.error');
    else log.warn(logPayload, 'http.error');

    // 5xx HTTPExceptions still represent server-side failures we want to
    // see in Sentry; 4xx are expected client errors and stay out.
    if (isSentryEnabled() && status >= 500) {
      captureToSentry(err, c, body.code);
    }

    // Bearer-only WWW-Authenticate suppresses the MCP HTTP transport's
    // automatic fallback to OAuth Dynamic Client Registration on 401 — see
    // require-pat-or-device.ts and the MCP spec §Authorization. Gated on 401
    // because WWW-Authenticate is meaningless (and RFC-violating, per
    // RFC 7235) on other statuses; if a future contributor adds
    // `cause.wwwAuthenticate` to a 5xx for symmetry, we don't want it on
    // the wire.
    if (status === 401 && wwwAuthenticate) {
      c.header('WWW-Authenticate', wwwAuthenticate);
    }

    return c.json(body, status);
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
  return c.json(body, 500);
};

function captureToSentry(
  err: unknown,
  c: Context<{ Variables: RequestIdVars }>,
  code: string,
): void {
  Sentry.withScope((scope) => {
    scope.setTag('http.method', c.req.method);
    scope.setTag('http.path', c.req.path);
    scope.setTag('error.code', code);
    const requestId = c.get('requestId');
    if (requestId) scope.setTag('request.id', requestId);
    Sentry.captureException(err);
  });
}

export const notFoundHandler: NotFoundHandler<{ Variables: RequestIdVars }> = (c: Context) => {
  return c.json<ErrorBody>(
    { code: 'NOT_FOUND', message: `Not Found: ${c.req.method} ${c.req.path}` },
    404,
  );
};
