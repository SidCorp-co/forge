/**
 * Pair a box for an integration test: the registry row plus the credential it
 * authenticates with (ISS-932).
 *
 * A suite that wants a device-authenticated request needs both halves and they
 * now come from two modules; this is the seam that used to be
 * `issueDeviceToken`, kept in one place so a change to how a box is credentialed
 * is one edit rather than nine.
 */

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
