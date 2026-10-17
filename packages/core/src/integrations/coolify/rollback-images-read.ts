import { CoolifyApiError, type CoolifyClient } from './client.js';
import type { CoolifyRollbackImagesResponse } from './types.js';

/** Coolify was asked for something and no HTTP answer could be read: the request never arrived, never returned, or came back as something that is not JSON. */
export class CoolifyReadFailedError extends Error {
  readonly kind: 'unreachable' | 'timeout' | 'not-json';
  constructor(kind: CoolifyReadFailedError['kind'], message: string) {
    super(message);
    this.name = 'CoolifyReadFailedError';
    this.kind = kind;
  }
}

function failure(err: unknown, READ: string, lacks: string): CoolifyReadFailedError {
  const name = err instanceof Error ? err.name : '';
  const said = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CoolifyReadFailedError(
      'timeout',
      `Coolify timed out: it did not answer ${READ} in time, so Forge has no ${lacks} to read.`,
    );
  }
  if (err instanceof SyntaxError) {
    return new CoolifyReadFailedError(
      'not-json',
      `Coolify answered ${READ} with something that is not JSON (${said}), so Forge has no ${lacks} to read.`,
    );
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? ` ${cause.code}` : '';
  return new CoolifyReadFailedError(
    'unreachable',
    `Could not reach Coolify for ${READ} (${said}${code}), so Forge has no ${lacks} to read.`,
  );
}

/** One read of Coolify, with a failure that is not an HTTP answer named rather than left as whatever the transport threw. */
export async function readNamingFailure<T>(
  read: string,
  lacks: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CoolifyApiError) throw err;
    throw failure(err, read, lacks);
  }
}

export function readRollbackImagesNamingFailure(
  client: Pick<CoolifyClient, 'listRollbackImages'>,
  resourceUuid: string,
): Promise<CoolifyRollbackImagesResponse> {
  return readNamingFailure(
    `GET /api/v1/applications/${resourceUuid}/rollback-images`,
    'rollback image list',
    () => client.listRollbackImages(resourceUuid),
  );
}

/** The application list, named the same way: the settings picker and the bound-target panel read it. */
export function listApplicationsNamingFailure<T>(client: {
  listApplications(): Promise<T>;
}): Promise<T> {
  return readNamingFailure('GET /api/v1/applications', 'application list', () =>
    client.listApplications(),
  );
}
