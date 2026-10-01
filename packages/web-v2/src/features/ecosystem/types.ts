// The channel and contract shapes as core serves them (core `ecosystem/channel-schema.ts`,
// `channel-view.ts`, `channel-register.ts`, `api-page.ts`, `contract/party-read.ts`).

export const DOCUMENT_TYPES = [
  "change-notice",
  "acknowledgement",
  "rfi",
  "change-request",
  "decision",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

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
}

export interface ThreadView {
  thread: string;
  documents: (Omit<DocumentView, "thread" | "hold" | "standing">)[];
  holds: ThreadHold[];
}

export interface OutboxResponse {
  documents: (Omit<DocumentView, "side" | "thread" | "standing">)[];
  returned: number;
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

export interface RegisterResponse {
  documents: RegisterRow[];
  returned: number;
  total: number;
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
  artifact: "none" | "repository" | "upload";
  lifecycle: string;
  ecosystems: string[];
  versions: string[];
  consumers: { project?: NamedProject; ecosystem: string; builtAgainst: string }[];
}

export interface ApiPage {
  project: NamedProject;
  reader:
    | { access: "project" }
    | { access: "party"; via: { ecosystem: string; visibility: string; projects: string[] }[] };
  declared: boolean;
  ecosystems: { id: string; slug: string; name: string; visibility: string }[];
  publishes: ApiPagePublication[];
  consumes: { contract: string; provider?: NamedProject; ecosystem: string; builtAgainst: string }[];
  commitments: {
    versioning: string;
    deprecationNoticeDays: number;
    responseDays: Record<string, number>;
  } | null;
}

export interface VersionChange {
  element: string;
  kind: string;
  level: string;
  text: string;
  check?: string;
}

/** One recorded version, in the fields both readers share: the diff and when it was observed. */
export interface ContractVersion {
  contractVersion: string;
  previous: string | null;
  observedAt: string;
  diff: { tool: string; classification: string; changes: VersionChange[] };
}

export interface Measurement {
  outcome: string;
  version: string | null;
  environments: string[];
  observedAt: string;
  settledAt: string | null;
  /** The provider's own read only. */
  commit?: string;
  branch?: string;
  reason?: string | null;
}

export interface ContractReading {
  /** Whose contract it is, when read as a consumer; absent on the provider's own read. */
  provider?: NamedProject;
  versions: ContractVersion[];
  measurements: Measurement[];
}
