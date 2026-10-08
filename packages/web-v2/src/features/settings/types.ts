import type { AnswerStyle } from "@forge/contracts/assistant-self";

export type { AnswerStyle, PreferenceChange } from "@forge/contracts/assistant-self";

export interface AssistantPreferences {
  answerStyle: AnswerStyle;
  /** Standing instructions the assistant follows in every reply to this person; null when none. */
  assistantInstructions: string | null;
}

export type PatScope = "read" | "write";
export const PAT_SCOPES: PatScope[] = ["read", "write"];

type PatGrant = "unstated" | "full" | "named";

/** What `GET /api/pat` says the create door will accept. */
export interface PatMenu {
  /** The route groups a named grant picks from. */
  permissions: string[];
  /** The approvals and other acts a named grant holds only where it names them; Full holds them. */
  explicit: string[];
  full: string;
}

export interface PatToken {
  id: string;
  name: string;
  prefix: string;
  scopes: PatScope[];
  projectIds: string[] | null;
  permissions: string[] | null;
  grant: PatGrant;
  /** ISS-497 — non-null = project-level token bound to exactly this project
   *  (X-Forge-Project-Slug header optional); null = user-level token. */
  boundProjectId: string | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

/** `POST /api/pat` echoes the row plus the one-time `plaintext` token. */
export interface PatTokenCreated extends PatToken {
  plaintext: string;
}

export interface CreatePatInput {
  name: string;
  scopes: PatScope[];
  permissions: string[];
  expiresAt?: string | null;
  /** ISS-497 — bind the token to a single project (project-level token).
   *  null/omitted = user-level (all the user's projects). */
  boundProjectId?: string | null;
}

export interface NotificationRow {
  id: string;
  notificationId: string;
  projectId: string | null;
  type: string;
  kind: string;
  title: string;
  body: string | null;
  readAt: string | null;
  members: number;
  openMembers: number;
  resolvedNotice: boolean;
  issueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
}
