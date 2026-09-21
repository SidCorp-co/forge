import type { AnswerStyle } from "@forge/contracts";
export type ThemePref = "system" | "light" | "dark";
export type LanguagePref = "en" | "vi";

export type { AnswerStyle, PreferenceChange } from "@forge/contracts";

export interface AssistantPreferences {
  answerStyle: AnswerStyle;
  /** Standing instructions the assistant follows in every reply to this person; null when none. */
  assistantInstructions: string | null;
}

export interface Preferences {
  theme: ThemePref;
  language: LanguagePref;
  notifyOnMention: boolean;
  lastSeenWhatsNew: string | null;
  /** The org the user is currently "working in" (ISS-469 global org switcher);
   *  null = no explicit choice (client resolves to the personal org). */
  activeOrgId: string | null;
  updatedAt: string | null;
}

export type PatScope = "read" | "write" | "admin";
export const PAT_SCOPES: PatScope[] = ["read", "write", "admin"];

export interface PatToken {
  id: string;
  name: string;
  prefix: string;
  scopes: PatScope[];
  projectIds: string[] | null;
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
