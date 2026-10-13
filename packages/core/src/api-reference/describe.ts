import type { MiddlewareHandler } from 'hono';
import type { ZodType, z } from 'zod';
import { statusToCode } from '../middleware/error.js';

/** A JSON body with this shape. */
export type JsonAnswer = {
  readonly kind: 'json';
  readonly schema: ZodType;
  readonly description: string;
};

/** No body at all: a 204, or a 200 that says only that it happened. */
export type EmptyAnswer = { readonly kind: 'empty'; readonly description: string };

/** A redirect. The `Location` is the answer. */
export type RedirectAnswer = { readonly kind: 'redirect'; readonly description: string };

/** A body that is not JSON: a script, a page, an event stream, a file. */
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

/** An answer that is not JSON: `raw('text/plain', 'the install script')`. */
export function raw(contentType: string, description: string): RawAnswer {
  return { kind: 'raw', contentType, description };
}

/**
 * An error answer. `fail('NOT_FOUND', 'the issue does not exist')` names one code and when it
 * happens; `fail({ A: 'when a', B: 'when b' })` names several for one status; `fail()` is the
 * code `middleware/error.ts` derives from the status, which the handler gets by throwing no code.
 */
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
  /**
   * Why the route no longer does its work: it answers only a refusal, and the reference marks it
   * deprecated instead of asking for a success it cannot give.
   */
  readonly retired?: string;
  /** A request body that is not JSON, which no validator can describe. */
  readonly body?: { readonly contentType: string; readonly description: string };
};

const operations = new WeakMap<object, OperationDeclaration>();

/** What a route's descriptor declared, or undefined for any other handler. */
export function operationOf(handler: object): OperationDeclaration | undefined {
  return operations.get(handler);
}

/**
 * Declares what a route answers. It is placed before the handler and passes every request through;
 * the reference reads it from the route table, so the answer is declared where the handler is and
 * not in a document beside it.
 */
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

/**
 * Returns `body` as it is. It exists so the compiler holds a handler to its declaration: `body`
 * must be what `schema` accepts, so a handler that sends a field the schema lacks, omits one it
 * requires or sends the wrong type fails `tsc`, in the gate every change meets, and no longer in a
 * run against a real database after the merge.
 *
 * `return c.json(answer(tokenSchema, publicShape(row)))`
 */
export function answer<S extends ZodType>(_schema: S, body: z.input<S>): z.input<S> {
  return body;
}
