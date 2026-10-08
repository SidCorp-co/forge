import { CoolifyApiError, type CoolifyClient } from './client.js';
import type { CoolifyRollbackImagesResponse } from './types.js';

/** Coolify was asked for the rollback images and no HTTP answer could be read: the request never arrived, never returned, or came back as something that is not JSON. */
export class CoolifyReadFailedError extends Error {
  readonly kind: 'unreachable' | 'timeout' | 'not-json';
  constructor(kind: CoolifyReadFailedError['kind'], message: string) {
    super(message);
    this.name = 'CoolifyReadFailedError';
    this.kind = kind;
  }
}

function failure(err: unknown, resourceUuid: string): CoolifyReadFailedError {
  const READ = `GET /api/v1/applications/${resourceUuid}/rollback-images`;
  const name = err instanceof Error ? err.name : '';
  const said = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CoolifyReadFailedError(
      'timeout',
      `Coolify timed out: it did not answer ${READ} in time, so Forge has no rollback image list to read.`,
    );
  }
  if (err instanceof SyntaxError) {
    return new CoolifyReadFailedError(
      'not-json',
      `Coolify answered ${READ} with something that is not JSON (${said}), so Forge has no rollback image list to read.`,
    );
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? ` ${cause.code}` : '';
  return new CoolifyReadFailedError(
    'unreachable',
    `Could not reach Coolify for ${READ} (${said}${code}), so Forge has no rollback image list to read.`,
  );
}

/** The rollback-images read, with a failure that is not an HTTP answer named rather than left as whatever the transport threw. */
export async function readRollbackImagesNamingFailure(
  client: Pick<CoolifyClient, 'listRollbackImages'>,
  resourceUuid: string,
): Promise<CoolifyRollbackImagesResponse> {
  try {
    return await client.listRollbackImages(resourceUuid);
  } catch (err) {
    if (err instanceof CoolifyApiError) throw err;
    throw failure(err, resourceUuid);
  }
}
