// Bus subscribers that wake the dispatcher.
//
// The WS heartbeat used to call `dispatchTickForProject` directly, which put
// `runners/heartbeat-ws.ts` inside a 52-file import cycle spanning issues,
// pipeline, jobs, ws, chat and mcp. The transport layer announces what happened;
// deciding that a tick follows belongs here.
//
// The two finalize paths joined it for the same reason: `finalize-done.ts` and
// `finalize-failure.ts` each imported `dispatch-tick.js`, closing
// dispatch-tick -> dispatcher -> finalize-failure -> {finalize-done ->} dispatch-tick.
// Both already emitted `jobCompleted` / `jobFailed` on the line above the call,
// so the announcement was there and only the decision needed moving.

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

  // cm:guard BOTH terminal events, not just failure. A job that ends `done` frees the same runner slot a failed one does, and dropping either half leaves that project's queued work waiting on the sweeper's backstop — a delay rather than a stall, which is how it would stay unnoticed.
  for (const event of ['jobCompleted', 'jobFailed'] as const) {
    bus.on(
      event,
      (p) => {
        void dispatchTickForProject(p.projectId);
      },
      { name: `dispatch-tick-on-${event}` },
    );
  }

  // cm:edge protocol -> packages/core/src/pipeline/hooks.ts — expiring or deleting an edge removes an L2 gate; this subscriber must tick immediately because PM graph-change handling is optional and cannot be the dispatcher wake path
  bus.on(
    'dependencyChanged',
    (p) => {
      void dispatchTickForProject(p.projectId);
    },
    { name: 'dispatch-tick-on-dependency-changed' },
  );
}
