import { env } from '../lib/env.js';
import { userByEmail } from './read.js';

/** The one member a demo core signs in: seeded by tests/helpers/demo-world.ts, never a real address. */
export const DEMO_MEMBER_EMAIL = 'demo.member@demo.forge.local';

/**
 * The demo member a demo core takes a credential-less socket for, null anywhere that is not a demo
 * core. The demo web signs its HTTP requests in on the server (web-v2 lib/demo-signin.ts), but a
 * browser cannot set a header on a WebSocket, and holds no cookie to send, so the socket is the one
 * door that has no credential to read.
 */
export async function demoMemberId(): Promise<string | null> {
  if (!env.FORGE_DEMO_MODE) return null;
  return (await userByEmail(DEMO_MEMBER_EMAIL))?.id ?? null;
}
