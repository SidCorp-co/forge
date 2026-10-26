import { nameOfDevice } from '../lib/device-pool.js';
import type { ChatClient } from './chat-turn.js';
import { badRequest } from './session-access.js';

/**
 * Refuses a checkout named for a session a runner device takes, saying which device and checkout it
 * runs in instead. Every remote client was resolved through the project's own binding (ISS-1236).
 */
export async function refuseRemoteCheckout(client: ChatClient, slug: string): Promise<never> {
  const named = client.deviceId ? await nameOfDevice(client.deviceId) : null;
  const device = named ?? 'the runner device this project picked';
  const runsIn = client.checkout
    ? `the checkout its binding records, ${client.checkout}`
    : `the checkout the device itself keeps for ${slug}, since its binding records no path`;
  throw badRequest({
    repoPath: `names a checkout, which only a local client chooses: this session runs on ${device}, in ${runsIn}. Leave repoPath out. To move that checkout, change the path on ${slug}'s Runners page, or run \`forge-runner bind ${slug} --path <dir>\` on ${device}`,
  });
}
