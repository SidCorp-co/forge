// Room name helpers — mirror `forge/core/src/ws/rooms.ts`. Keep in sync.

export const projectRoom = (projectId: string): string => `project:${projectId}`;
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
