import type { Device } from '../../src/db/schema.js';
import { issueDeviceCredential } from '../../src/devices/credential.js';
import { type RegisterDeviceInput, registerDevice } from '../../src/devices/register.js';

export async function pairDevice(
  input: RegisterDeviceInput,
): Promise<{ device: Device; plaintext: string }> {
  const device = await registerDevice(input);
  const plaintext = await issueDeviceCredential({
    deviceId: device.id,
    holderUserId: input.ownerId,
  });
  return { device, plaintext };
}
