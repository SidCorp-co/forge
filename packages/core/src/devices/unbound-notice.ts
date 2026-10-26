import { resolveNotifications } from '../notifications/auto-resolve.js';

export const unboundNoticeKey = (projectId: string, deviceId: string): string =>
  `device-not-bound:${projectId}:${deviceId}`;

export function resolveDeviceUnbound(projectId: string, deviceId: string): Promise<number> {
  return resolveNotifications(unboundNoticeKey(projectId, deviceId));
}
