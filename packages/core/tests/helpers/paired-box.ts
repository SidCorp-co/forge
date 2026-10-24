// A box serving a project the way a provisioned one does, for the tests that read whom its master
// acts as (ISS-590). Its own file, so a change to it selects only the tests that pair a box.

import { bindTestRunner, createTestDevice } from './factories.js';

/**
 * A box serving the project as a provisioned one does: its device credential held by whoever paired
 * it, and its checkout's credential, which its pane writes under, held by `actsAs`
 * (`devices/workspace-credential.ts:workspaceHolderFor`: the same agent for a box paired as one, the
 * project's agent for a box paired by a person). `actsAs: null` leaves the checkout without one.
 * Answers the device and the checkout credential's plaintext (null without one).
 */
export async function pairTestBox(
  projectId: string,
  who: { pairedBy: string; actsAs: string | null },
): Promise<{ deviceId: string; paneToken: string | null }> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { deviceTokenNameFor, workspaceTokenNameFor } = await import(
    '../../src/credentials/pat-format.js'
  );
  const deviceId = await createTestDevice(who.pairedBy);
  await bindTestRunner(projectId, deviceId);
  await mintPat({
    userId: who.pairedBy,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
  });
  if (who.actsAs === null) return { deviceId, paneToken: null };
  const pane = await mintPat({
    userId: who.actsAs,
    name: workspaceTokenNameFor(deviceId, projectId),
    scopes: ['read', 'write'],
    permissions: ['*'],
    projectIds: [projectId],
    deviceId,
  });
  return { deviceId, paneToken: pane.plaintext };
}
