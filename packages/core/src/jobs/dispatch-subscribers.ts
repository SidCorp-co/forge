// Bus subscribers that wake the dispatcher.
//
// The WS heartbeat used to call `dispatchTickForProject` directly, which put
// `runners/heartbeat-ws.ts` inside a 52-file import cycle spanning issues,
// pipeline, jobs, ws, chat and mcp. The transport layer announces what happened;
// deciding that a tick follows belongs here.

import type { HooksBus } from '../pipeline/hooks.js';
import { dispatchTickForProject } from './dispatch-tick.js';

// cm:guard registration is what makes this run — an unregistered subscriber is silent, and the symptom is a runner that comes online while its queued jobs sit until the sweeper's dispatcher backstop notices. That is a delay, not a stall, which is exactly why it could go unnoticed.
// cm:edge lockstep -> packages/core/src/index.ts — called there with the other register*Subscribers; deleting that call disables this with nothing going red
export function registerDispatchSubscribers(bus: HooksBus): void {
  bus.on(
    'runnerOnline',
    (p) => {
      // cm:why fire-and-forget, matching the direct call this replaced — the tick debounces per project and its own failures are logged there, so awaiting it here would only make a heartbeat wait on the dispatcher
      void dispatchTickForProject(p.projectId);
    },
    { name: 'dispatch-tick-on-runner-online' },
  );
}
