import { env } from '../lib/env.js';
import { userByEmail } from './read.js';

/** The one member a demo core signs in: seeded by tests/helpers/demo-world.ts, never a real address. */
export const DEMO_MEMBER_EMAIL = 'demo.member@demo.forge.local';

/**
 * The demo member a demo core signs in a request that carries no credential for, null anywhere that
 * is not a demo core: HTTP through web-host/demo-credential.ts, and the socket through attachWs's
 * `credentialless`, since a browser cannot set a header on a WebSocket and holds no cookie to send.
 */
export async function demoMemberId(): Promise<string | null> {
  if (!env.FORGE_DEMO_MODE) return null;
  return (await userByEmail(DEMO_MEMBER_EMAIL))?.id ?? null;
}
