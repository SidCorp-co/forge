// What project-config needs from modules it may not import: the projects row its document
// projects onto (same context, but projects imports project-config), and the running job a
// testing-secrets read is made for (execution, a context below in the order). The composition
// root fills them at boot (`provideProjectOrg` is the pattern).

import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';
import type { PatPrincipal } from '../middleware/require-pat.js';

export interface SecretResolveAudit {
  environment: string;
  profile: string;
  refs: string[];
  tokenId: string;
  deviceId: string | null;
}

type JobCredentialRead =
  | { ok: true; context: { agentSessionId: string; jobId: string | null } }
  | { ok: false; reason: 'not_pipeline_context' | 'ambiguous_pipeline_context'; detail: string };

interface ProjectConfigPorts {
  /** Write the document's slug and name onto the projects row; false when no row exists. */
  projectDocumentNames(
    tx: Tx,
    projectId: string,
    names: { slug: string; name: string },
  ): Promise<boolean>;
  /** Why no project route could address a project by this slug, or null when one can. */
  unaddressableSlug(slug: string): string | null;
  /** The job a job credential names, read from the credential's session. */
  jobOfCredential(
    caller: Pick<PatPrincipal, 'deviceId' | 'boundProjectId'>,
  ): Promise<JobCredentialRead>;
  /** Audit a resolve on the job's event log, committed before any value leaves. */
  recordSecretResolve(jobId: string, audit: SecretResolveAudit): Promise<void>;
  /** Hand the scrubber the values this job now holds. */
  rememberHandedOut(jobId: string, values: readonly string[]): void;
}

const slot = portSlot<ProjectConfigPorts>('project-config', 'provideProjectConfigPorts');
export const provideProjectConfigPorts = slot.provide;
export const projectConfigPorts = slot.get;
