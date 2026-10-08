// The channel and contract shapes as core serves them (core `ecosystem/channel-schema.ts`,
// `channel-view.ts`, `channel-register.ts`, `api-page.ts`, `contract/party-read.ts`).

import type { Copy } from "@/lib/i18n/product-copy";

export const DOCUMENT_TYPES = [
  "change-notice",
  "acknowledgement",
  "rfi",
  "change-request",
  "decision",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const REPLY_TYPES: Partial<Record<string, DocumentType[]>> = {
  "change-notice": ["acknowledgement"],
  rfi: ["decision"],
  "change-request": ["decision"],
};

export type DocumentState = "draft" | "submitted" | "returned" | "published" | "withdrawn" | "superseded";

/** Who wrote it, and through what door. The credential decides it, never the body. */
export type Author =
  | { kind: "agent"; id: string; via: "master" }
  | { kind: "person"; id: string; via: "assistant" | "web" | "cli" };

export interface Gate {
  mode: "publish" | "approve";
  decision?: "approved" | "returned";
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface ChannelDocument {
  id: string;
  number?: string | null;
  ecosystem: string;
  from: string;
  to: string[];
  inReplyTo?: string | null;
  type: DocumentType;
  subject: string;
  dueBy?: string;
  state: DocumentState;
  authoredBy: Author;
  gate?: Gate;
  publishedAt?: string;
  supersededBy?: string;
  withdrawnReason?: string;
  body: Record<string, unknown>;
}

export interface DocumentEvent {
  verb: string;
  from: DocumentState | null;
  to: DocumentState;
  by: { kind: "agent" | "person"; id: string; via: Author["via"] };
  reason?: string;
  supersededBy?: string;
  at: string;
}

export interface ThreadHold {
  id: string;
  thread: string;
  action: "hold" | "release";
  by: Author;
  side: string;
  at: string;
  reason?: string;
}

export type RecipientStatus = "awaiting" | "answered" | "overdue" | "not-owed";

export interface Standing {
  open: boolean;
  overdue: boolean;
  owner: string[];
  recipients: { project: string; status: RecipientStatus; answeredBy: string | null }[];
}

export interface DocumentView {
  id: string;
  document: ChannelDocument;
  events: DocumentEvent[];
  side: "sender" | "recipient";
  thread: string | null;
  hold: ThreadHold | null;
  standing: Standing | null;
  gateQuestionId: string | null;
}

export interface ThreadView {
  thread: string;
  documents: (Omit<DocumentView, "thread" | "hold" | "standing" | "gateQuestionId">)[];
  holds: ThreadHold[];
}

export interface RegisterRow {
  number: string;
  type: DocumentType;
  subject: string;
  from: string;
  to: string[];
  inReplyTo: string | null;
  thread: string | null;
  state: DocumentState;
  authoredBy: Author;
  publishedAt: string | null;
  dueBy: string | null;
  recipients: Standing["recipients"];
  open: boolean;
  overdue: boolean;
  owner: string[];
  hold: ThreadHold | null;
}

export interface EcosystemMembership {
  id: string;
  document: { ecosystem: string; project: string; state: string };
  ecosystem: { id: string; slug: string; name: string; channel: string; purpose?: string } | null;
}

export interface ProjectEcosystemsResponse {
  memberships: EcosystemMembership[];
  returned: number;
}

export interface NamedProject {
  id: string;
  slug: string;
  name: string;
}

export interface ApiPagePublication {
  contract: string;
  slug: string;
  title: string;
  summary?: string;
  type: string;
  artifact: "none" | "upload";
  lifecycle: string;
  ecosystems: string[];
  /** Each recorded version beside its decision; a party reads approved versions only. */
  versions: { version: string; approval: string }[];
  consumers: { project?: NamedProject; ecosystem: string; builtAgainst: string }[];
}

export interface ApiPage {
  project: NamedProject;
  reader:
    | { access: "project" }
    | {
        access: "party";
        via: { ecosystem: string; visibility: string; projects: string[] }[];
        /** Ecosystems this page is read through only for what it publishes there, before any consumption. */
        offered: { ecosystem: string; projects: string[] }[];
      };
  declared: boolean;
  ecosystems: { id: string; slug: string; name: string; visibility: string }[];
  publishes: ApiPagePublication[];
  consumes: { contract: string; provider?: NamedProject; ecosystem: string; builtAgainst: string }[];
  commitments: {
    versioning: string;
    deprecationNoticeDays: number;
    responseDays: Record<string, number>;
    /** Who last changed these windows: an agent proposes them, and a person holding admin may overwrite them. */
    setBy: { agency: "agent" | "human"; at: string } | null;
  } | null;
}


/** The full name of each document type, as rows and filters print it. */
export const TYPE_LABEL: Record<string, string> = {
  "change-notice": "Change notice",
  acknowledgement: "Acknowledgement",
  rfi: "Question",
  "change-request": "Change request",
  decision: "Decision",
};

/** A document type's name in the reader's language; a type this build does not know reads as sent. */
export function typeLabel(type: string, t: Copy): string {
  return type in TYPE_LABEL ? t(`ecosystem.type.${type as "rfi"}`) : type;
}

export type GateMode = "publish" | "approve";
export type ReplyWindowType = "change-notice" | "rfi" | "change-request";

// contract -> packages/core/src/ecosystem/workspace-read.ts:readWorkspace — `GET /api/ecosystems/mine`, the person's ecosystems, invitations and threads across them
export interface WorkspaceEcosystem {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  code: string;
  steward: { id: string; name: string | null; mine: boolean };
  visibility: "counterparties" | "all";
  responseDays: Record<ReplyWindowType, number>;
  gate: Record<DocumentType, GateMode>;
  members: string[];
}

export interface WorkspaceInvitation {
  membership: string;
  ecosystem: string;
  project: string;
  invitedAt: string;
}

export interface WorkspaceDraft {
  id: string;
  ecosystem: string;
  from: string;
  inReplyTo: string;
  type: DocumentType;
  state: DocumentState;
  authoredBy: Author;
  gate: Gate | null;
  gateQuestionId: string | null;
}

export interface WorkspaceRead {
  ecosystems: WorkspaceEcosystem[];
  invitations: WorkspaceInvitation[];
  threads: (RegisterRow & { ecosystem: string })[];
  drafts: WorkspaceDraft[];
  projects: NamedProject[];
  mine: string[];
}

/** The ecosystem document core stores (`ecosystem-v1`), as create and settings write it. */
export interface EcosystemDocument {
  $schema: string;
  version: 1;
  ecosystem: { id?: string; slug: string; name: string; purpose?: string; steward: string };
  channel: { code: string; responseDays: Record<ReplyWindowType, number> };
  gate: Record<DocumentType, GateMode>;
  visibility: { members: "counterparties" | "all" };
}

export interface HeldEcosystem {
  id: string;
  revision: number;
  document: EcosystemDocument;
}
