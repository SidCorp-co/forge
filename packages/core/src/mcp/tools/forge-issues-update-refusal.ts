/** A `forge_issues` update writes in one transaction, so a refusal raised before the commit says
 *  first, after its code, that nothing it carried was written (ISS-1229 r11). */

import { TransitionError } from '../../issues/transition-error.js';
import { zodRefusalMessage } from '../zod-refusal.js';
import { toMcpIssueError } from './forge-issues-errors.js';

const UNWRITTEN = 'Nothing this update carried was written';

const MOVE_REFUSED =
  'The status move was refused, so nothing else this update carried was written: send it again without `data.status` to write the rest';

const CODES = /^((?:[A-Z][A-Z0-9_]*:\s*)*)([\s\S]*)$/;

/** Capitalised, unless it opens on a name a caller sends. */
function opened(text: string): string {
  const first = text.split(/\s/, 1)[0] ?? '';
  return /^[a-z]+[,;:]?$/.test(first) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function leadWith(message: string, sentence: string): string {
  if (/^[A-Z][A-Z0-9_]*$/.test(message.trim())) return `${message.trim()}: ${sentence}.`;
  const [, codes = '', rest = ''] = CODES.exec(message) ?? [];
  const said = rest.trim();
  return said === '' ? `${codes}${sentence}.` : `${codes}${sentence}. ${opened(said)}`;
}

/** A refused move says how to send the rest; any other refusal names the move among what it kept. */
export function unwrittenRefusal(err: unknown, sentStatus: boolean): unknown {
  if (err instanceof TransitionError) {
    return new TransitionError(
      err.code,
      `${MOVE_REFUSED}. ${opened(err.detail.trim())}`,
      err.details,
    );
  }
  const mapped = toMcpIssueError(err);
  if (!(mapped instanceof Error)) return mapped;
  const message = zodRefusalMessage(mapped) ?? mapped.message;
  return new Error(
    leadWith(message, sentStatus ? `${UNWRITTEN}, the status move included` : UNWRITTEN),
  );
}

/** Whether the call sent a status, read off its raw arguments: the input check may be what refused it. */
function sentStatusIn(args: unknown): boolean {
  const data = (args as { data?: unknown } | null)?.data;
  return (
    typeof data === 'object' && data !== null && (data as { status?: unknown }).status !== undefined
  );
}

/** Run a step that writes nothing; where the call is an update, a refusal from it says so first. */
export function unwrittenIfUpdate<T>(args: unknown, step: () => T): T {
  try {
    return step();
  } catch (err) {
    if ((args as { action?: unknown } | null)?.action !== 'update') throw err;
    throw unwrittenRefusal(err, sentStatusIn(args));
  }
}

/** An update's step before its write, its refusal saying that nothing the update carried was written. */
export async function unwrittenOnRefusal<T>(
  sentStatus: boolean,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw unwrittenRefusal(err, sentStatus);
  }
}
