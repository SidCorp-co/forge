/**
 * One refusal type for the whole write path.
 *
 * Every message names the offender — the element, the attribute and its legal
 * set, or the missing slot. That is the deliverable, not a nicety: an agent
 * that gets back `invalid body` has nothing to correct on its next call, and
 * the only reason this gate produces compliance where a guide produced 14-28%
 * is that a refusal tells the writer exactly what to change (ISS-898 UC6).
 */
export class BodyInvalidError extends Error {
  readonly code = 'BODY_INVALID';

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BodyInvalidError';
  }
}
