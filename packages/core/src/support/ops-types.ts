// The shape of an operations room's act and of its outcome (REQ-75 BC-20..BC-24), shared by the
// gate (`ops-acts.ts`), its reads (`ops-reads.ts`) and its writes (`ops-writes.ts`).

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { Refusal } from '@forge/contracts/refusal';
import type { SupportRecordKind } from '@forge/contracts/support';

export type OpsOutcome<T> = { ok: true; value: T } | { ok: false; refusals: Refusal[] };

export type OperationsActInput =
  | { action: 'projects' }
  | {
      action: 'issues';
      project: string;
      status?: IssueStatus | undefined;
      key?: string | undefined;
    }
  | { action: 'releases'; project: string }
  | {
      action: 'move';
      thread: string;
      issue: string;
      project?: string | undefined;
      to: IssueStatus;
      reason?: string | undefined;
    }
  | { action: 'draft_requirement'; thread: string; project: string; title: string; summary: string }
  | {
      action: 'draft_feedback';
      thread: string;
      project: string;
      kind: SupportRecordKind;
      title: string;
      summary: string;
      requirement?: string | undefined;
      issue?: string | undefined;
      screen?: string | undefined;
    }
  | { action: 'research'; thread: string; url: string };
