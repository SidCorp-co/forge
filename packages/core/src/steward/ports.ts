// What the steward needs from the modules above it and from the process entry, handed in at boot
// (ADR 0008): core's own app, which every act's door is called through as the steward account; the
// master wake, which is the ws door's, and the accounts a master acts as; the release gate's rule for what counts on a landing; and the one standing read (REQ-48 BC-8), which lane A's
// `standing/` module serves. Read only inside a call, so an unprovided port fails the call that
// needed it and names the provide it lacked.

import type { Said } from '@forge/contracts/said';
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
   * The project's release as facts the steward's acts may not restate otherwise: whether production
   * exists, what its delivery policy owes at the gate, whether a live release batch claims the
   * issue, and what verdicts landed work still owes (the release module's
   * `steward-release-facts.ts:stewardReleaseFacts`).
   */
  releaseFacts(projectId: string, issueId: string | null): Promise<string>;
  /**
   * Whether the project has a running build Forge observes: a production environment its releases
   * deploy to (the release module's `gate.ts:runningBuildObserved`). Where it has none, nothing a
   * steward act could judge as running exists.
   */
  runningBuildObserved(projectId: string): Promise<boolean>;
  /**
   * The accounts the project's master acts as, whose permissions decide what an ask of the master can
   * be answered with (ISS-607): for each box serving the project, the holder of the credential its
   * checkout carries, which every write of its pane goes out under (the devices module's
   * `workspaceHolderUserId`, ISS-590). A serving box whose checkout carries none is `unread`, by id:
   * what it writes as is not known, so it is never taken to hold anything.
   */
  masterAccounts(projectId: string): Promise<MasterAccounts>;
  /**
   * Whether the project's master takes the act a wait names: an account it acts as holds the
   * permission of every decision act the wait asks for (the development module's
   * `needs-you-agent-takes.ts:masterTakesWait`, the rule Needs you leaves a row to the master by,
   * ISS-758).
   */
  masterTakes(projectId: string, act: Said): Promise<boolean>;
}

/** The accounts a project's master acts as, and the serving boxes whose account cannot be read. */
export interface MasterAccounts {
  accounts: string[];
  unread: string[];
}

const ports = portSlot<StewardPorts>('steward', 'provideStewardPorts');
export const provideStewardPorts = ports.provide;
export const stewardPorts = ports.get;

const standings = portSlot<{ read: OpenStandingsRead }>('steward', 'provideStewardStandings');

/** The standing read lane A serves (`GET /api/projects/:id/standings`); provided at boot. */
export const provideStewardStandings = (read: OpenStandingsRead): void =>
  standings.provide({ read });
export const openStandings: OpenStandingsRead = (projectId) => standings.get().read(projectId);
