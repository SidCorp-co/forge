/** `GET /api/projects/:id/sessions-and-holds` — mirrors core `pipeline/sessions-and-holds.ts`. */

export interface HeldIssueRef {
  issueId: string;
  displayId: string;
  title: string;
}

/** What the box itself last reported about a session. */
export interface SessionReport {
  incarnation: string;
  work: string;
  blockerKind: string | null;
  waitingOn: string | null;
  observedAt: string;
}

export interface LiveSession {
  id: string;
  kind: string;
  title: string | null;
  status: string;
  runtimeState: string | null;
  deviceId: string | null;
  deviceName: string | null;
  parentSessionId: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  issues: HeldIssueRef[];
  report: SessionReport | null;
}

export type PersonOwes = "information" | "decision" | "resource";

export type Holder =
  | {
      by: "session";
      sessionId: string;
      sessionTitle: string | null;
      sessionKind: string;
      deviceName: string | null;
      since: string;
    }
  | {
      by: "claim";
      holder: string;
      /** The claim's last renewal: a claim records no time it began. */
      renewedAt: string | null;
      expiresAt: string | null;
      next: string | null;
    }
  | {
      by: "person";
      status: "needs_info" | "waiting" | "on_hold";
      owes: PersonOwes | null;
      since: string | null;
      why: string | null;
    };

export interface HeldIssue extends HeldIssueRef {
  status: string;
  holders: Holder[];
}

export interface SessionsAndHolds {
  sessions: LiveSession[];
  holds: HeldIssue[];
  readAt: string;
}
