import { DEVICE_STATUSES } from '@forge/contracts/runner-machine';

export const devicePlatforms = ['macos', 'linux', 'windows'] as const;
export type DevicePlatform = (typeof devicePlatforms)[number];

export const deviceStatuses = DEVICE_STATUSES;
export type DeviceStatus = (typeof deviceStatuses)[number];
