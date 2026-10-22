// What the steward needs from the modules above it and from the process entry, handed in at boot
// (ADR 0008): core's own app, which every act's door is called through as the steward account; the
// master wake, which is the ws door's; the release gate's rule for what counts on a landing; and the one standing read (REQ-48 BC-8), which lane A's
// `standing/` module serves. Read only inside a call, so an unprovided port fails the call that
// needed it and names the provide it lacked.

import type { OpenStandingsRead } from '@forge/contracts/steward';
import { portSlot } from '../lib/port-slot.js';

interface StewardPorts {
  /** Core's REST app (`app.fetch`), answering one request as a client's would be. */
  doorFetch(request: Request): Promise<Response>;
  /** Wake the project's master boxes, naming the steward and what it asks. */
  wakeMasters(args: {
    projectId: string;
    subjectKey: string;
    ask: string;
  }): Promise<{ boxes: number; delivered: number }>;
  /**
   * Why an issue may not be sent back from the release gate, or null where it may: on a project with
   * no production environment, every live criterion counting on its landing (the release module's
   * `landed-build.ts:landedReopenRefusal`).
   */
  landedReopenRefusal(issueId: string): Promise<string | null>;
}

const ports = portSlot<StewardPorts>('steward', 'provideStewardPorts');
export const provideStewardPorts = ports.provide;
export const stewardPorts = ports.get;

const standings = portSlot<{ read: OpenStandingsRead }>('steward', 'provideStewardStandings');

/** The standing read lane A serves (`GET /api/projects/:id/standings`); provided at boot. */
export const provideStewardStandings = (read: OpenStandingsRead): void =>
  standings.provide({ read });
export const openStandings: OpenStandingsRead = (projectId) => standings.get().read(projectId);
