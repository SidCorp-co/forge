// web-v2 feature module: activity — presentation derivation. Maps a raw
// `action` + `payload` into a human verb, a detail line, and a pipeline-stage
// hue (the feed's "stage hue" — reuses the @/design STAGES palette). All
// payload reads are defensive: the jsonb shape varies by action.
import { STAGES, stageColor, type StageKey } from "@/design";
import type { ActivityRow, FeedRow } from "./types";

/** Issue status → pipeline stage, so a `statusChanged` event takes the hue of
 *  the stage it moved INTO. Mirrors the pipeline ladder. */
const STATUS_STAGE: Record<string, StageKey> = {
  open: "triage",
  needs_info: "triage",
  draft: "triage",
  confirmed: "clarify",
  waiting: "clarify",
  approved: "plan",
  in_progress: "code",
  developed: "code",
  reopen: "code",
  deploying: "test",
  testing: "test",
  tested: "test",
  pass: "test",
  staging: "release",
  released: "release",
  closed: "release",
};

/** Action prefix → fallback stage hue when no status payload is present. */
const ACTION_STAGE: Record<string, StageKey> = {
  comment: "review",
  member: "triage",
  dependency: "plan",
  pm: "review",
  agent: "code",
  job: "code",
  pipeline: "code",
};

export interface ParsedAction {
  category: string;
  verb: string;
}

/** Split `issue.statusChanged` → `{ category: 'issue', verb: 'statusChanged' }`. */
export function parseAction(action: string): ParsedAction {
  const idx = action.indexOf(".");
  if (idx === -1) return { category: action, verb: "" };
  return { category: action.slice(0, idx), verb: action.slice(idx + 1) };
}

/** Human-readable verb label for the timeline. */
export function verbLabel(row: ActivityRow): string {
  const { category, verb } = parseAction(row.action);
  switch (row.action) {
    case "issue.created":
      return "Issue created";
    case "issue.statusChanged":
      return "Status changed";
    case "issue.updated":
      return "Issue updated";
    case "comment.created":
      return "Commented";
    case "issue.dependency.added":
      return "Dependency added";
    case "issue.dependency.removed":
      return "Dependency removed";
    case "issue.manualHold.set":
      return "Put on hold";
    case "issue.manualHold.cleared":
      return "Hold cleared";
    default: {
      // Title-case the dotted verb, e.g. `pm.decision` → "Pm decision".
      const words = verb.replace(/([A-Z])/g, " $1").replace(/[._]/g, " ").trim() || category;
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/** Secondary detail line (from → to, etc.). Best-effort against jsonb payload. */
export function detailLine(row: ActivityRow): string | null {
  const p = row.payload ?? {};
  if (row.action === "issue.statusChanged" && (p.from || p.to)) {
    return `${String(p.from ?? "?")} → ${String(p.to ?? "?")}`;
  }
  if (row.action.startsWith("issue.dependency") && p.kind) {
    return `${String(p.kind)} edge`;
  }
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.note === "string") return p.note;
  return null;
}

/** Pipeline-stage hue for the row's left rail / dot. */
export function eventStage(row: ActivityRow): StageKey | null {
  const p = row.payload ?? {};
  if (row.action === "issue.statusChanged" && typeof p.to === "string") {
    return STATUS_STAGE[p.to] ?? null;
  }
  const { category } = parseAction(row.action);
  return ACTION_STAGE[category] ?? null;
}

/** CSS color for a row, derived from its stage (neutral when none). */
export function eventColor(row: ActivityRow): string {
  const stage = eventStage(row);
  return stage ? stageColor(stage) : "var(--fg-subtle)";
}

const VERB_ICON: Record<string, string> = {
  issue: "list",
  comment: "mail",
  member: "agent",
  dependency: "link",
  pm: "shield",
  agent: "agent",
  job: "cpu",
  pipeline: "pipeline",
};

/** Icon name for the row's actor/category. */
export function eventIcon(row: ActivityRow): string {
  if (row.actorType === "device") return "server";
  return VERB_ICON[parseAction(row.action).category] ?? "activity";
}

/** Relative time label, e.g. "3m ago". */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const diff = nowMs - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isToday(iso: string, nowMs: number): boolean {
  const d = new Date(iso);
  const now = new Date(nowMs);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export interface TodayStats {
  total: number;
  byStage: { stage: StageKey; label: string; color: string; count: number }[];
}

/** Context-rail rollup: today's event count + per-stage breakdown (legend). */
export function todayStats(rows: FeedRow[], nowMs: number = Date.now()): TodayStats {
  const today = rows.filter((r) => isToday(r.createdAt, nowMs));
  const counts = new Map<StageKey, number>();
  for (const r of today) {
    const stage = eventStage(r);
    if (stage) counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  return {
    total: today.length,
    byStage: STAGES.map((s) => ({
      stage: s.key,
      label: s.label,
      color: s.color,
      count: counts.get(s.key) ?? 0,
    })),
  };
}
