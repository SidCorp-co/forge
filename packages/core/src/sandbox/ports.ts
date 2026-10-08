// What the sandbox needs from the composition root: core's own REST app, which a script's
// ctx.forge.get is answered by in-process under the run owner's token, so every read meets the
// authorization a person's own GET would. Handed in at boot; read only inside a call.

import { portSlot } from '../lib/port-slot.js';

interface SandboxPorts {
  /** Core's REST app (`app.fetch`), answering one request as a client's would be. */
  restFetch(request: Request): Promise<Response>;
}

const slot = portSlot<SandboxPorts>('sandbox', 'provideSandboxPorts');
export const provideSandboxPorts = slot.provide;
export const sandboxPorts = slot.get;
