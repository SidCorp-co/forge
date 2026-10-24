// The one way a tool refuses an argument it was sent, or was not sent for the action it names
// (REQ-73 BC-5, ISS-602). Each fault is named at its JSON pointer; the tool's valid shape is added
// where the tool is served — `mcp/input-gate.ts:gatedTool` completes every argument refusal with the
// shape its published input declares, so no tool writes its own shape sentence or its own `need`.

import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { jsonPointer, RefusalError, requestRefusals } from './refusal.js';

export type ArgumentFault = { path: string; fault: string; code?: string };

/** A fault in the arguments a tool was called with: one row per field at its path, `BAD_REQUEST` unless named. */
export class ArgumentRefusal extends RefusalError {
  constructor(faults: readonly ArgumentFault[]) {
    super(
      faults.map((f) => ({ code: f.code ?? 'BAD_REQUEST', path: f.path, detail: f.fault })),
      'BAD_REQUEST',
    );
    this.name = 'ArgumentRefusal';
  }
}

/** One argument refused at `path` (a JSON pointer such as `/issue`), saying what was wrong with it. */
export function argumentRefusal(path: string, fault: string): ArgumentRefusal {
  return new ArgumentRefusal([{ path, fault }]);
}

/**
 * The fields one action needs, refused by name where the call left one out: every missing field is
 * a row at its own path, so a caller missing two learns both at once.
 */
export function need<T extends Record<string, unknown>, K extends keyof T & string>(
  input: T,
  action: string,
  ...fields: K[]
): T & { [P in K]-?: NonNullable<T[P]> } {
  const missing = fields.filter((f) => input[f] === undefined || input[f] === null);
  if (missing.length > 0) {
    throw new ArgumentRefusal(
      missing.map((f) => ({ path: `/${f}`, fault: `action ${action} needs ${f}` })),
    );
  }
  return input as T & { [P in K]-?: NonNullable<T[P]> };
}

/**
 * A validator's verdict on part of the arguments, each issue at its own path; `rename` maps a field
 * the validator names to the argument the caller sent it as.
 */
export function zodArgumentRefusal(
  error: z.ZodError,
  rename: Readonly<Record<string, string>> = {},
): ArgumentRefusal {
  return new ArgumentRefusal(
    error.issues.map((issue) => {
      const [head, ...rest] = issue.path;
      const path =
        typeof head === 'string' && rename[head] !== undefined
          ? [rename[head], ...rest]
          : issue.path;
      return { path: jsonPointer(path), fault: issue.message };
    }),
  );
}

/**
 * The faults a route helper's 400 carries (`middleware/route-errors.ts:badRequest` says only
 * "Invalid input" and keeps the reason in `cause.details`), each at its path; null for any other
 * error. A sentence with no path of its own is placed at `at`.
 */
export function badRequestFaults(err: unknown, at = ''): ArgumentFault[] | null {
  if (!(err instanceof HTTPException) || err.status !== 400) return null;
  const cause = (err.cause ?? {}) as { code?: unknown; details?: unknown };
  const code = typeof cause.code === 'string' ? cause.code : 'BAD_REQUEST';
  return requestRefusals(code, err.message, cause.details).map((r) => ({
    code: r.code,
    path: r.path || at,
    fault: r.detail,
  }));
}

/** Reads what one argument names; a route helper's 400 on the way is refused at that argument. */
export async function readingArgument<T>(path: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    const faults = badRequestFaults(err, path);
    if (faults) throw new ArgumentRefusal(faults);
    throw err;
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * An argument naming a row by its key (`REQ-12`, or its bare number) or its uuid, the shapes the
 * services' own readers take (`requirements/read.ts:rowIn`, `feedback/read.ts:rowIn`,
 * `mockups/read.ts:rowIn`). Declared in the tool's input, a malformed one is refused at its path
 * with the valid shape before the reader can answer it as a row it did not find.
 */
export function keyArgument(prefix: string, what: string) {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^(?:(?:${prefix}-)?\\d{1,9}|${UUID})$`, 'i'),
      `${what} is named by its key, like ${prefix}-12, or its uuid`,
    )
    .describe(`${what} key (${prefix}-n) or uuid`);
}
