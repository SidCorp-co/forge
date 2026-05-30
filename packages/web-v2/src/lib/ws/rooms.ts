// Room name helpers — mirror `packages/core/src/ws/rooms.ts`. Keep in sync.
// Ported verbatim from `packages/web/src/lib/ws/rooms.ts` (ISS-288).

export const projectRoom = (projectId: string): string => `project:${projectId}`;
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
