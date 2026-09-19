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
