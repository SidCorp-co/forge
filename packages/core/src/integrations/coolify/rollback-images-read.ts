import { unreachedBecause, unreachedBy } from '../unreached.js';
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

function failure(
  err: unknown,
  READ: string,
  lacks: string,
  address: string | undefined,
): CoolifyReadFailedError {
  // Said of the server at the saved address: whether it is Coolify is what the read was to show,
  // and the transport's own text is not a reader's sentence (ISS-1421 r18).
  const where = address ? `the server at ${address}` : 'the address saved on this connection';
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CoolifyReadFailedError(
      'timeout',
      `Forge got no answer to ${READ} in time from ${where}. Forge has no ${lacks} to read.`,
    );
  }
  if (err instanceof SyntaxError) {
    return new CoolifyReadFailedError(
      'not-json',
      `${where.charAt(0).toUpperCase()}${where.slice(1)} answered ${READ} with something that is not JSON, so it may not be Coolify. Forge has no ${lacks} to read.`,
    );
  }
  const unreached = unreachedBy(err);
  return new CoolifyReadFailedError(
    'unreachable',
    unreached
      ? `Forge could not reach ${where} for ${READ}, because ${unreachedBecause(unreached.reason)}. Forge has no ${lacks} to read.`
      : `Forge could not read ${READ} from ${where}. Forge has no ${lacks} to read.`,
  );
}

/** One read of Coolify, with a failure that is not an HTTP answer named rather than left as whatever the transport threw. */
export async function readNamingFailure<T>(
  read: string,
  lacks: string,
  fn: () => Promise<T>,
  address?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CoolifyApiError) throw err;
    throw failure(err, read, lacks, address);
  }
}

export function readRollbackImagesNamingFailure(
  client: Pick<CoolifyClient, 'listRollbackImages'> & { address?: string },
  resourceUuid: string,
): Promise<CoolifyRollbackImagesResponse> {
  return readNamingFailure(
    `GET /api/v1/applications/${resourceUuid}/rollback-images`,
    'rollback image list',
    () => client.listRollbackImages(resourceUuid),
    client.address,
  );
}

/** The application list, named the same way: the settings picker and the bound-target panel read it. */
export function listApplicationsNamingFailure<T>(client: {
  listApplications(): Promise<T>;
  address?: string;
}): Promise<T> {
  return readNamingFailure(
    'GET /api/v1/applications',
    'application list',
    () => client.listApplications(),
    client.address,
  );
}
