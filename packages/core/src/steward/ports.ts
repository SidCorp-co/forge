// What the steward needs from the modules above it and from the process entry, handed in at boot
// (ADR 0008): core's own app, which every act's door is called through as the steward account; the
// master wake, which is the ws door's, and the accounts a master acts as; the release gate's rule for what counts on a landing; and the one standing read (REQ-48 BC-8), which lane A's
// `standing/` module serves. Read only inside a call, so an unprovided port fails the call that
// needed it and names the provide it lacked.

import type { PilesView } from '@forge/contracts/door-use';
import type { CorrectionItemKind } from '@forge/contracts/lessons';
import type { Said } from '@forge/contracts/said';
import type { WaitingOn } from '@forge/contracts/standing';
import type { OpenStandingsRead } from '@forge/contracts/steward';
import type { SelfAuditFailed, SelfAuditRequest } from '@forge/contracts/support-reply-audit';
import { portSlot } from '../lib/port-slot.js';
import type { Refusal } from '../lib/refusal.js';

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
   * Whether the project's master takes the act a wait names, by the one rule
   * (`@forge/contracts/who-owes:whoOwes`, ISS-1058): a release act read with what the next release
   * carries (the release module's `master-owed-acts.ts:masterTakesReleaseAct`), a decision act as
   * Needs you leaves a row to the master by (the development module's
   * `needs-you-agent-takes.ts:masterTakesWait`, ISS-758).
   */
  masterTakes(projectId: string, act: Said): Promise<boolean>;
  /**
   * The release not yet shipped that holds the next act of an issue owing nothing of its own (every
   * criterion earned, on a project with production), or null (the release module's
   * `criteria-facts.ts:releaseHoldingActOf`, ISS-1040).
   */
  releaseHoldingAct(projectId: string, issueId: string): Promise<HoldingRelease | null>;
  /** The release `version` names while it has not shipped (`carrying-release.ts:holdingReleaseOf`). */
  holdingRelease(projectId: string, version: string): Promise<HoldingRelease | null>;
  /**
   * Each text every prompt of the project carries, against its cap (the metrics read model's
   * `piles.ts:readPiles`, ISS-1251): a pile past its cap is owed consolidation, never a cut.
   */
  piles(projectId: string): Promise<PilesView>;
  /**
   * The entries of a pile the project owns, each by the key an agent edits it under (a knowledge
   * slug, a lesson's `L-n`), which the steward proposes merges over (`piles.ts:readPileEntries`).
   */
  pileEntries(projectId: string, pile: 'always_knowledge' | 'lessons_map'): Promise<PileEntry[]>;
  /**
   * A steward job's audit of its own run, read against the door catalog and kept in the one verdict
   * store every agent's self-audit goes to (the support module's `reply-audit/self-audit.ts`,
   * ISS-1251), a failed one a correction on the run's subject; or the refusal naming the door that
   * cannot stand, with nothing kept.
   */
  keepSelfAudit(
    input: StewardSelfAudit,
  ): Promise<{ ok: true } | { ok: false; refusals: Refusal[] }>;
}

/** One entry of a pile: the key it is edited under, and its text. */
export interface PileEntry {
  key: string;
  text: string;
}

/** What a steward job says of its own run in its done call. */
export interface StewardSelfAudit {
  projectId: string;
  runId: string;
  userId: string;
  subject: { kind: CorrectionItemKind; id: string; key: string };
  failed: SelfAuditFailed;
  missed: SelfAuditRequest['missed'];
}

/** A release that has not shipped and its own wait, as its page reads it. */
export interface HoldingRelease {
  version: string;
  state: string;
  waitingOn: WaitingOn;
  /** Since when it has waited so. */
  since: string;
  /** Its wait in one line, which an ask on it is keyed on. */
  line: string;
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
