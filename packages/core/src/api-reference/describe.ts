import type { MiddlewareHandler } from 'hono';
import type { ZodType, z } from 'zod';
import { statusToCode } from '../middleware/error.js';

export type JsonAnswer = {
  readonly kind: 'json';
  readonly schema: ZodType;
  readonly description: string;
};

/** No body at all: a 204, or a 200 that says only that it happened. */
export type EmptyAnswer = { readonly kind: 'empty'; readonly description: string };

export type RedirectAnswer = { readonly kind: 'redirect'; readonly description: string };

/** A body that is not JSON. */
export type RawAnswer = {
  readonly kind: 'raw';
  readonly contentType: string;
  readonly description: string;
};

/** An error in the envelope `middleware/error.ts` writes, with the codes this route can give. */
export type FailAnswer = {
  readonly kind: 'fail';
  readonly codes: ReadonlyArray<{ readonly code: string; readonly when: string }>;
};

export type Answer = JsonAnswer | EmptyAnswer | RedirectAnswer | RawAnswer | FailAnswer;

/** A JSON answer: the schema describes the body the handler sends, as it crosses the wire. */
export function json(schema: ZodType, description = 'OK'): JsonAnswer {
  return { kind: 'json', schema, description };
}

export function empty(description = 'Done, with no body'): EmptyAnswer {
  return { kind: 'empty', description };
}

export function redirect(description: string): RedirectAnswer {
  return { kind: 'redirect', description };
}

export function raw(contentType: string, description: string): RawAnswer {
  return { kind: 'raw', contentType, description };
}

/** An error answer: `fail('CODE', 'when')`, `fail({ A: 'when a', B: 'when b' })`, or `fail()` for the code derived from the status. */
export function fail(code?: string | Readonly<Record<string, string>>, when = ''): FailAnswer {
  if (code === undefined) return { kind: 'fail', codes: [{ code: '', when }] };
  if (typeof code === 'string') return { kind: 'fail', codes: [{ code, when }] };
  return {
    kind: 'fail',
    codes: Object.entries(code).map(([name, why]) => ({ code: name, when: why })),
  };
}

export type OperationDeclaration = {
  /** One line: what calling this does, in the caller's words. */
  readonly summary: string;
  readonly description?: string;
  /** Keyed by status. A status below 400 takes a success answer, 400 and above `fail`. */
  readonly responses: Readonly<Record<number, Answer>>;
  /** Why the route answers only a refusal; the reference marks it deprecated. */
  readonly retired?: string;
  /** A request body that is not JSON, which no validator can describe. */
  readonly body?: { readonly contentType: string; readonly description: string };
};

const operations = new WeakMap<object, OperationDeclaration>();

/** What a route's descriptor declared, or undefined for any other handler. */
export function operationOf(handler: object): OperationDeclaration | undefined {
  return operations.get(handler);
}

/** Declares what a route answers, placed before its handler; the reference reads it from the route table. */
export function describeOperation(declaration: OperationDeclaration): MiddlewareHandler {
  for (const [status, answer] of Object.entries(declaration.responses)) {
    const code = Number(status);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new Error(
        `describeOperation: "${status}" is not an HTTP status (${declaration.summary})`,
      );
    }
    if (code >= 400 && answer.kind !== 'fail' && answer.kind !== 'json') {
      throw new Error(
        `describeOperation: ${status} is an error status and takes fail(...) or json(...), not ${answer.kind} (${declaration.summary})`,
      );
    }
    if (code < 400 && answer.kind === 'fail') {
      throw new Error(
        `describeOperation: ${status} is a success status and cannot take fail(...) (${declaration.summary})`,
      );
    }
  }
  if (
    declaration.retired !== undefined &&
    Object.keys(declaration.responses).some((s) => Number(s) < 400)
  ) {
    throw new Error(
      `describeOperation: a retired route answers only a refusal, so it declares no success (${declaration.summary})`,
    );
  }
  const middleware: MiddlewareHandler = async (_c, next) => next();
  operations.set(middleware, declaration);
  return middleware;
}

/** The code an error answer carries: the one named, or the one `middleware/error.ts` derives. */
export function codeFor(status: number, code: string): string {
  return code === '' ? statusToCode(status) : code;
}

/** Returns `body` as it is, so `tsc` holds a handler's answer to its schema: `c.json(answer(schema, body))`. */
export function answer<S extends ZodType>(_schema: S, body: z.input<S>): z.input<S> {
  return body;
}
