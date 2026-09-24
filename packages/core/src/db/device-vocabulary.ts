export const devicePlatforms = ['macos', 'linux', 'windows'] as const;
export type DevicePlatform = (typeof devicePlatforms)[number];

export const deviceStatuses = ['online', 'offline', 'revoked'] as const;
export type DeviceStatus = (typeof deviceStatuses)[number];
