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
  asked: string,
  lacks: string,
  address: string | undefined,
): CoolifyReadFailedError {
  // Said of the server at the saved address: whether it is Coolify is what the read was to show,
  // and the transport's own text is not a reader's sentence (ISS-1421 r18). What was asked for is
  // said in words; the route is the error's own business (ISS-1421 r28, judge-114).
  const where = address ? `the server at ${address}` : 'the address saved on this connection';
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CoolifyReadFailedError(
      'timeout',
      `Forge asked ${where} for ${asked} and got no answer in time. Forge has no ${lacks} to read.`,
    );
  }
  if (err instanceof SyntaxError) {
    return new CoolifyReadFailedError(
      'not-json',
      `Forge asked ${where} for ${asked}, and it answered with something that is not JSON, so it may not be Coolify. Forge has no ${lacks} to read.`,
    );
  }
  const unreached = unreachedBy(err);
  return new CoolifyReadFailedError(
    'unreachable',
    unreached
      ? `Forge could not reach ${where} to ask for ${asked}, because ${unreachedBecause(unreached.reason)}. Forge has no ${lacks} to read.`
      : `Forge could not read ${asked} from ${where}. Forge has no ${lacks} to read.`,
  );
}

/** One read of Coolify, with a failure that is not an HTTP answer named rather than left as whatever the transport threw. */
export async function readNamingFailure<T>(
  asked: string,
  lacks: string,
  fn: () => Promise<T>,
  address?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CoolifyApiError) throw err;
    throw failure(err, asked, lacks, address);
  }
}

export function readRollbackImagesNamingFailure(
  client: Pick<CoolifyClient, 'listRollbackImages'> & { address?: string },
  resourceUuid: string,
): Promise<CoolifyRollbackImagesResponse> {
  return readNamingFailure(
    `the rollback images of application ${resourceUuid}`,
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
    'its list of applications',
    'application list',
    () => client.listApplications(),
    client.address,
  );
}
