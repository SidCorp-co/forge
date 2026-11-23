// What project-config needs from modules it may not import: the projects row its document
// projects onto (same context, but projects imports project-config), and the running job a
// testing-secrets read is made for (execution, a context below in the order). The composition
// root fills them at boot (`provideProjectOrg` is the pattern).

import type { ReviewRunDeclaration } from '@forge/contracts/agent-sessions';
import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import type { DecisionNamingProduction } from './variables-rules.js';

export interface SecretResolveAudit {
  /** The environment judged; null for a review run's read where no one environment names its profile. */
  environment: string | null;
  profile: string;
  refs: string[];
  tokenId: string;
  deviceId: string | null;
}

/** A run a master declared on the caller's box, named by the id the call sends. */
export type DeclaredRunRead =
  | { kind: 'none' }
  | { kind: 'refused'; reason: 'ended' | 'queued' | 'foreign'; detail: string }
  | {
      kind: 'run';
      sessionId: string;
      runId: string;
      projectId: string;
      /** The run id the box declared it under; null where it declared none. */
      boxRunId: string | null;
      issueIds: string[];
      /** The requirement a judge run was declared at in place of any issue (ISS-735); null otherwise. */
      requirement: string | null;
      /** Where a person declared it for review: who, the one profile it reads, its end. */
      review: ReviewRunDeclaration | null;
    };

export interface RunSecretResolveAudit extends SecretResolveAudit {
  issueId: string;
  sessionId: string;
  runId: string;
  deviceId: string;
  /** What named the environment read: the issue's landing, the release that carried it, the run, or the project's fallback. */
  basis?: 'landing' | 'release' | 'named' | 'judgedOn' | 'production';
  /** The person who declared the run, where it is a review run. */
  declaredBy?: string;
}

export interface RequirementSecretReadAudit {
  requirementId: string;
  sessionId: string;
  runId: string;
  boxRunId: string | null;
  deviceId: string;
  /** The person the declaring box's credential acts for. */
  declaredBy: string | null;
  /** The delivering issue whose landing named the environment; null where none did. */
  issueId: string | null;
  basis: 'landing' | 'judgedOn' | 'production';
  environment: string;
  profile: string;
  refs: string[];
  tokenId: string;
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
  /** Hand the scrubber the values this job, or this declared run's session, now holds. */
  rememberHandedOut(jobOrSessionId: string, values: readonly string[]): void;
  /** The run a master declared on the caller's box that `asked` names. */
  declaredRunOfCall(
    caller: Pick<PatPrincipal, 'deviceId' | 'boundProjectId' | 'projectIds'>,
    asked: string,
  ): Promise<DeclaredRunRead>;
  /** A live declared run `asked` names on any box of a project the caller's account belongs to. */
  declaredRunElsewhere(
    caller: Pick<PatPrincipal, 'userId'>,
    asked: string,
  ): Promise<{ box: string; keys: string[] } | null>;
  /** The live resident master session of the project on the caller's box, or null (REQ-88). */
  liveMasterSessionOf(args: { deviceId: string; projectId: string }): Promise<string | null>;
  /**
   * The standing decisions naming a production environment (REQ-80 BC-11) on the run's issues and on
   * the project's other open ones, oldest first; their writers unnamed.
   */
  decisionsNamingProduction(
    projectId: string,
    runIssueIds: readonly string[],
  ): Promise<Array<Omit<DecisionNamingProduction, 'writer'> & { writer: DecisionWriter }>>;
  /** Audit a declared run's resolve on the issue it judges, committed before any value leaves. */
  recordRunSecretResolve(audit: RunSecretResolveAudit): Promise<void>;
  /** The shipped release still holding the issue's work, by version; null while none does (ISS-1407). */
  shippedReleaseOf(projectId: string, issueId: string): Promise<{ version: string } | null>;
  /** The requirement a judge run was declared at, by key, and the project's issues delivering it. */
  requirementJudgedBy(
    projectId: string,
    key: string,
  ): Promise<{ requirementId: string; issueIds: string[] } | null>;
  /** Audit a requirement judge's resolve on the requirement, committed before any value leaves. */
  recordRequirementSecretRead(audit: RequirementSecretReadAudit): Promise<void>;
  /** Open a review run a person declared on a box serving the project (`devices/review-run.ts`). */
  openReviewRun(args: {
    projectId: string;
    box: string;
    /** The issue reviewed, by its key or its id. */
    issue: string;
    declaration: ReviewRunDeclaration;
  }): Promise<{
    sessionId: string;
    runId: string;
    box: { id: string; name: string };
    /** The issue's canonical key. */
    issue: string;
  }>;
}

type DecisionWriter = Omit<DecisionNamingProduction['writer'], 'name'>;

const slot = portSlot<ProjectConfigPorts>('project-config', 'provideProjectConfigPorts');
export const provideProjectConfigPorts = slot.provide;
export const projectConfigPorts = slot.get;
