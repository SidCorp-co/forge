import type { Device as DeviceRow } from '@forge/contracts';

/**
 * `GET /api/me/devices` returns a curated subset of the `devices` row —
 * sensitive fields like `tokenHash`/`tokenPrefix` are stripped server-side.
 */
export type MyDevice = Pick<
  DeviceRow,
  | 'id'
  | 'name'
  | 'platform'
  | 'agentVersion'
  | 'status'
  | 'lastSeenAt'
  | 'pairedAt'
  | 'capabilities'
  | 'createdAt'
>;
