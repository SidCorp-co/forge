// What the devices kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules, never an adapter or a domain). Read
// only inside a call, never at import.

import type { PolicyRefusalCode } from '@forge/contracts/project-config';
import type { Tx } from '../db/client.js';
import type { RefusalError } from '../lib/refusal.js';

/** The runner build this deployment publishes. */
export interface PublishedRunnerBuild {
  version: string;
  commit: string | null;
}

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
  /** The refusal a dispatch against a project's policy is answered with. */
  policyRefusal(code: 'POLICY_UNDECLARED', projectId: string, status: string | null): RefusalError;
  policyRefusalOf(err: unknown): { code: PolicyRefusalCode; detail: string } | null;
  /** Throws the policy refusal when the project declares no policy. */
  requirePolicy(projectId: string): Promise<unknown>;
  /** Every pull request linked to each issue, open first, as the repository projection holds them. */
  readPullRequestsForIssues(issueIds: string[]): Promise<Map<string, unknown[]>>;
  readDeclaredSource(
    projectId: string,
  ): Promise<{ repository: string | null; defaultBranch: string | null }>;
  remoteOf(repository: string, transport: 'ssh' | 'https'): string;
  withDeclaredSource<T extends { projectId: string }>(
    rows: readonly T[],
  ): Promise<
    (T & { repository: string | null; baseBranch: string | null; workspaceSetup: string | null })[]
  >;
  projectsWithHostCredential(projectIds: string[]): Promise<Set<string>>;
  isHttpsGitUrl(url: string | null | undefined): boolean;
  decryptSecret(enc: Buffer): string;
  publishedRunnerBuild(): Promise<PublishedRunnerBuild | null>;
  mainRunnerHead(): string | null;
  cmpVersion(a: string, b: string): number;
  questions: {
    askQuestion(input: DeviceQuestion): Promise<{ id: string }>;
    registerWaiter(args: { questionId: string; deviceId: string; runId: string }): Promise<void>;
    waiterFor(args: { questionId: string; deviceId: string; runId: string }): Promise<unknown>;
    answerOf(questionId: string): Promise<unknown>;
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
  /** The user a project's workspace handle acts as, minted when the project has none. */
  projectHandleUserId(tx: Tx, projectId: string): Promise<string>;
}

let provided: DevicesPorts | null = null;

export function provideDevicesPorts(ports: DevicesPorts): void {
  provided = ports;
}

export function devicesPorts(): DevicesPorts {
  if (!provided) {
    throw new Error(
      'devices: no ports were provided, so a box cannot reach the policy, source, git, question or comment modules it needs; the process entry calls provideDevicesPorts before it serves',
    );
  }
  return provided;
}
