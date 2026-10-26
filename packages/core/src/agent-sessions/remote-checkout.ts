import { nameOfDevice } from '../lib/device-pool.js';
import type { ChatClient } from './chat-turn.js';
import { badRequest } from './session-access.js';

/** A remote client came through the project's own binding, so its device's name is ours to show. */
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
