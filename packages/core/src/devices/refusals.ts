import type { DeviceRefusalCode } from '@forge/contracts/devices';
import { refuser } from '../lib/refusal.js';

export const refuseDevice = refuser<DeviceRefusalCode>('DEVICE_REFUSED');
