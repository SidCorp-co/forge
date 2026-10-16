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
  /** When the box first reported this work, blocker and wait; every report restamps `observedAt`. */
  since: string;
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
  /** How long core lets this session go unheard before it ends it; `null` where no silence does;
   *  absent on a read that predates it. */
  silenceLimitMs?: number | null;
  /** The job type and skill a step session was opened under, which its title begins with. */
  jobType?: string | null;
  skillName?: string | null;
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
