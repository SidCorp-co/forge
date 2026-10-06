import type { InboxView } from "./routes";
import type { WorkspaceDraft, WorkspaceRead } from "./types";

export type InboxRow = WorkspaceRead["threads"][number];

export const INBOX_LABEL: Record<InboxView, string> = {
  "needs-me": "Needs me",
  waiting: "Waiting on others",
  overdue: "Overdue",
  held: "Held",
  working: "Masters working",
  answered: "Answered",
  closed: "Closed",
};

export const INBOX_TIP: Record<InboxView, string> = {
  "needs-me": "A project of yours owes these a reply, and nobody has held them",
  waiting: "A project of yours sent these, and another member still owes the reply",
  overdue: "A reply is past its due date",
  held: "Someone held the thread, so the masters on it stop until it is released",
  working: "A master of one of your projects has drafted the reply and it is not sent yet",
  answered: "Every recipient owing a reply has sent it",
  closed: "Withdrawn or superseded",
};

const isHeld = (r: InboxRow) => r.hold?.action === "hold";

/** The unpublished reply a project of the reader's is writing to this row, if any. */
export function replyDraft(row: InboxRow, drafts: readonly WorkspaceDraft[]): WorkspaceDraft | null {
  return drafts.find((d) => d.inReplyTo === row.number) ?? null;
}

// every view is derived from core's register row and the reader's own projects; nothing here stores a status, so a lapsed due date reads overdue on the next read
export function inView(view: InboxView, row: InboxRow, mine: ReadonlySet<string>, drafts: readonly WorkspaceDraft[]) {
  const owesMine = row.owner.some((o) => mine.has(o));
  switch (view) {
    case "needs-me":
      return row.open && owesMine && !isHeld(row);
    case "waiting":
      return row.open && mine.has(row.from) && !owesMine;
    case "overdue":
      return row.overdue;
    case "held":
      return isHeld(row);
    case "working":
      return replyDraft(row, drafts)?.authoredBy.kind === "agent";
    case "answered":
      return !row.open && row.state === "published" && row.recipients.some((r) => r.status === "answered");
    case "closed":
      return row.state !== "published";
  }
}

export function needsMe(read: WorkspaceRead, ecosystem?: string): number {
  const mine = new Set(read.mine);
  return read.threads.filter((r) => (!ecosystem || r.ecosystem === ecosystem) && inView("needs-me", r, mine, read.drafts)).length;
}

/** Whole days from today to a `YYYY-MM-DD` due date; negative when it has passed. */
export function daysUntil(due: string): number {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [y, m, d] = due.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

/** The ecosystems the person belongs to: one of their projects is active in it, or their org stewards it. */
export const joinedEcosystems = (read: WorkspaceRead) =>
  read.ecosystems.filter((e) => e.members.length > 0 || e.steward.mine);
