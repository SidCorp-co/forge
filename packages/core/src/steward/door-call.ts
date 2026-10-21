// One call through an existing door (REQ-48 BC-12): a REST request answered by core's own app, under
// the credential of whoever acts, so the door checks that actor's access exactly as it would a
// client's. The steward calls with its account's token; the undo door calls with the person's own.

import { stewardPorts } from './ports.js';

export type DoorMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DoorRequest {
  method: DoorMethod;
  /** The path under core, `/api/...`, with its params filled. */
  path: string;
  body?: unknown;
}

export interface DoorAnswer {
  status: number;
  ok: boolean;
  /** The parsed body, or null where it was not JSON. */
  json: Record<string, unknown> | null;
  text: string;
}

/** `METHOD /api/...`, as an act's record names the door it called. */
export const doorName = (req: DoorRequest): string => `${req.method} ${req.path.split('?')[0]}`;

/**
 * The request answered as `headers` would be: `{ authorization: 'Bearer <token>' }` for a token, or
 * the person's own credential headers forwarded from the request that asked.
 */
export async function callDoor(
  req: DoorRequest,
  headers: Record<string, string>,
): Promise<DoorAnswer> {
  const response = await stewardPorts().doorFetch(
    new Request(`http://forge.internal${req.path}`, {
      method: req.method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    }),
  );
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    json =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** The refusal code a door answered with, where its body names one. */
export function refusalCodeOfAnswer(answer: DoorAnswer): string | null {
  const code = answer.json?.code;
  return typeof code === 'string' ? code : null;
}
