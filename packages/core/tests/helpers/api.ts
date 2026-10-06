import { signUserToken } from '../../src/credentials/jwt.js';
import { mintPat } from '../../src/credentials/pat.js';
import { app } from '../../src/index.js';
import { declareOutboxQueues } from '../../src/outbox/queues.js';
import { isBossStarted, startBoss } from '../../src/queue/boss.js';

export type Body = Record<string, unknown>;

export interface ApiResponse {
  status: number;
  body: Body;
  headers: Headers;
}

/** A request through the process's own app, its middleware and error handler included. */
export async function api(
  token: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  if (!isBossStarted()) {
    await startBoss();
    await declareOutboxQueues();
  }
  const res = await app.fetch(
    new Request(`http://forge.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  let parsed: Body;
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Body);
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** A session token for `userId`, as the login route signs one. */
export const userToken = (userId: string): Promise<string> => signUserToken(userId);

/** A personal access token for `userId`, scoped to `projectIds`. */
export async function patToken(
  userId: string,
  projectIds: string[],
  name = 'test',
): Promise<string> {
  return (await mintPat({ userId, name, projectIds })).plaintext;
}
