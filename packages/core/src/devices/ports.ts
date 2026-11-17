// What the devices kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules, never an adapter or a domain). Read
// only inside a call, never at import.

import type { GateId, ResolvedGate } from '@forge/contracts/gate-profiles';
import type { PolicyRefusalCode } from '@forge/contracts/project-config';
import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';
import type { RefusalError } from '../lib/refusal.js';

/** A question a box asks on behalf of its master, as the device route validated it. */
interface DeviceQuestion {
  id: string;
  projectId: string;
  prompt: string;
  blockerKind: string;
  answer: unknown;
  [field: string]: unknown;
}

/** A notice posted on an issue by a box, screened and mirrored as any comment is. */
interface DeviceNotice {
  issueId: string;
  authorId: string;
  authorDeviceId: string;
  body: string;
}

interface DevicesPorts {
  /** The project's effective policy document, or null when it declares none. */
  readEffectivePolicy(projectId: string): Promise<{ document: unknown } | null>;
  /** Every gate's mode on the project under its gate profile (REQ-76). */
  readGateModes(projectId: string): Promise<Readonly<Record<GateId, ResolvedGate>>>;
  /** The refusal a dispatch against a project's policy is answered with. */
  policyRefusal(code: 'POLICY_UNDECLARED', projectId: string, status: string | null): RefusalError;
  policyRefusalOf(err: unknown): { code: PolicyRefusalCode; detail: string } | null;
  /** The refusal a dispatch at `status` would meet under `held`, or null when it would run. */
  policyGapOf(
    projectId: string,
    held: { document: unknown } | null,
    status: string,
  ): { code: PolicyRefusalCode; detail: string } | null;
  /** Throws the policy refusal when the project declares no policy. */
  requirePolicy(projectId: string): Promise<unknown>;
  /** Every pull request linked to each issue, open first, as the repository projection holds them. */
  readPullRequestsForIssues(issueIds: string[]): Promise<Map<string, unknown[]>>;
  readDeclaredSource(
    projectId: string,
  ): Promise<{ repository: string | null; defaultBranch: string | null }>;
  /**
   * Where a project's checkout clones its repository from: the host's own https URL, or Forge's git
   * relay where the binding's provider reaches git only through it (REQ-73 BC-5).
   */
  checkoutRemoteOf(projectId: string, repository: string): Promise<string>;
  /** Forge's git relay URL where the binding is relayed, else null: what `bind --path` points origin at. */
  relayRemoteOf(projectId: string, repository: string): Promise<string | null>;
  withDeclaredSource<T extends { projectId: string }>(
    rows: readonly T[],
  ): Promise<
    (T & { repository: string | null; baseBranch: string | null; workspaceSetup: string | null })[]
  >;
  projectsWithHostCredential(projectIds: string[]): Promise<Set<string>>;
  isHttpsGitUrl(url: string | null | undefined): boolean;
  mainRunnerHead(): string | null;
  cmpVersion(a: string, b: string): number;
  /** The orientation a box writes into a checkout of the project: the one affordances table and the project's always-applied rules. */
  checkoutOrientation(projectId: string, slug: string): Promise<string>;
  /** Records the rules and lessons that orientation carries against a run just opened (ISS-1065); never throws. */
  recordOrientationCarried(run: { projectId: string; deviceId: string; sessionId: string }): void;
  questions: {
    askQuestion(input: DeviceQuestion): Promise<{ id: string }>;
    registerWaiter(args: { questionId: string; deviceId: string; runId: string }): Promise<void>;
    waiterFor(args: { questionId: string; deviceId: string; runId: string }): Promise<unknown>;
    answerOf(questionId: string): Promise<unknown>;
    /** Tell the project's admins of a dialog the box answered on a resident session (ISS-1268 C2). */
    raiseSessionPrompt(raised: {
      projectId: string;
      session: string;
      text: string;
      needs: string | null;
      by: 'catalog' | 'safe' | 'unread';
      answer: string;
    }): Promise<'told' | 'nobody'>;
    /** End a relayed permission prompt nobody answered within the box's bound (ISS-1268 B3). */
    expirePermissionPrompt(args: {
      questionId: string;
      projectId: string;
      deviceId: string;
      waitedSeconds: number;
    }): Promise<{ id: string; status: 'void'; voidReason: string }>;
  };
  comments: {
    postIssueNotice(notice: DeviceNotice, tx?: Tx): Promise<unknown>;
    postIssueNoticeOnce(notice: DeviceNotice & { marker: string }): Promise<unknown | null>;
    latestIssueCommentWith(
      issueId: string,
      markers: readonly string[],
      tx?: Tx,
    ): Promise<string | null>;
  };
  /** The id of requirement `ref` (`REQ-76`) of the project, or null where it holds none (ISS-735). */
  requirementIdOf(projectId: string, ref: string): Promise<string | null>;
  /** The user a project's workspace handle acts as, minted when the project has none. */
  projectHandleUserId(tx: Tx, projectId: string): Promise<string>;
  /**
   * What each project bound to the box holds (`live`) and waits on (`waiting`, `urgent` where one is a
   * release follow-through) of its steward's runner jobs: runs on the box like any other (ISS-1255).
   */
  stewardSlotDemand(
    executor: Pick<Tx, 'execute'>,
    deviceId: string,
  ): Promise<Map<string, { live: number; waiting: number; urgent: boolean }>>;
}

const slot = portSlot<DevicesPorts>('devices', 'provideDevicesPorts');
export const provideDevicesPorts = slot.provide;
export const devicesPorts = slot.get;
