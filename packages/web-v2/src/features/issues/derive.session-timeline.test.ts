import { describe, expect, it } from "vitest";
import { deriveSessionTimeline, humanizeSessionGroup } from "./derive";
import type { IssueAgentSession } from "./types";

/** Build a hydrated agent-session row (only the fields the timeline reads). */
function sess(over: {
  id: string;
  group?: string | null;
  jobType?: string | null;
  claude?: string | null;
  device?: string | null;
  status?: string;
  startedAt?: string;
}): IssueAgentSession {
  const metadata: Record<string, unknown> = {};
  if (over.group !== undefined && over.group !== null) metadata.sessionGroup = over.group;
  if (over.jobType !== undefined && over.jobType !== null) metadata.jobType = over.jobType;
  return {
    id: over.id,
    status: over.status ?? "completed",
    metadata: Object.keys(metadata).length ? metadata : null,
    createdAt: over.startedAt ?? "2026-06-03T20:00:00.000Z",
    updatedAt: over.startedAt ?? "2026-06-03T20:00:00.000Z",
    title: null,
    deviceId: over.device ?? null,
    startedAt: over.startedAt ?? null,
    claudeSessionId: over.claude ?? null,
  };
}

describe("humanizeSessionGroup", () => {
  it("maps known group keys", () => {
    expect(humanizeSessionGroup("build")).toBe("Build");
    expect(humanizeSessionGroup("planning")).toBe("Planning");
    expect(humanizeSessionGroup("verify")).toBe("Verify");
  });
  it("title-cases unknown keys (never leaks the raw key)", () => {
    expect(humanizeSessionGroup("my-custom_group")).toBe("My Custom Group");
  });
  it("falls back for null/empty", () => {
    expect(humanizeSessionGroup(null)).toBe("Session");
    expect(humanizeSessionGroup(undefined)).toBe("Session");
  });
});

describe("deriveSessionTimeline", () => {
  it("returns [] for empty / missing input", () => {
    expect(deriveSessionTimeline(undefined)).toEqual([]);
    expect(deriveSessionTimeline(null)).toEqual([]);
    expect(deriveSessionTimeline([])).toEqual([]);
  });

  it("marks the first same-group session fresh and subsequent reuse resumed (chain)", () => {
    // 3 verify sessions sharing one claudeSessionId → 1 fresh + 2 resumed.
    const t = deriveSessionTimeline([
      sess({ id: "s1", group: "verify", jobType: "review", claude: "cl-v", startedAt: "2026-06-03T20:00:00.000Z" }),
      sess({ id: "s2", group: "verify", jobType: "test", claude: "cl-v", startedAt: "2026-06-03T20:05:00.000Z" }),
      sess({ id: "s3", group: "verify", jobType: "release", claude: "cl-v", startedAt: "2026-06-03T20:10:00.000Z" }),
    ]);
    expect(t.map((e) => e.continuity)).toEqual(["fresh", "resumed", "resumed"]);
    expect(t[0].freshReason).toBe("first-in-group");
    // The chain is connected after the first (same claudeSessionId as prev).
    expect(t.map((e) => e.connectedToPrev)).toEqual([false, true, true]);
    expect(t.map((e) => e.groupLabel)).toEqual(["Verify", "Verify", "Verify"]);
  });

  it("sorts chronologically even when the hydrator returns updatedAt desc", () => {
    const t = deriveSessionTimeline([
      sess({ id: "late", group: "verify", jobType: "release", claude: "cl-v", startedAt: "2026-06-03T20:10:00.000Z" }),
      sess({ id: "early", group: "verify", jobType: "review", claude: "cl-v", startedAt: "2026-06-03T20:00:00.000Z" }),
    ]);
    expect(t.map((e) => e.id)).toEqual(["early", "late"]);
    expect(t.map((e) => e.continuity)).toEqual(["fresh", "resumed"]);
  });

  it("breaks the chain at a group boundary (build vs planning → two fresh)", () => {
    const t = deriveSessionTimeline([
      sess({ id: "b", group: "build", jobType: "code", claude: "cl-b", startedAt: "2026-06-03T19:00:00.000Z" }),
      sess({ id: "p", group: "planning", jobType: "plan", claude: "cl-p", startedAt: "2026-06-03T19:30:00.000Z" }),
    ]);
    expect(t.map((e) => e.continuity)).toEqual(["fresh", "fresh"]);
    expect(t.map((e) => e.freshReason)).toEqual(["first-in-group", "first-in-group"]);
    expect(t.map((e) => e.connectedToPrev)).toEqual([false, false]);
  });

  it("flags a fresh same-group session that ran on a different device", () => {
    const t = deriveSessionTimeline([
      sess({ id: "a", group: "build", jobType: "code", claude: "cl-1", device: "dev-A", startedAt: "2026-06-03T19:00:00.000Z" }),
      sess({ id: "b", group: "build", jobType: "fix", claude: "cl-2", device: "dev-B", startedAt: "2026-06-03T19:10:00.000Z" }),
    ]);
    expect(t[1].continuity).toBe("fresh");
    expect(t[1].freshReason).toBe("different-device");
  });

  it("flags prior-failed when same device but the prior session failed", () => {
    const t = deriveSessionTimeline([
      sess({ id: "a", group: "build", jobType: "code", claude: "cl-1", device: "dev-A", status: "failed", startedAt: "2026-06-03T19:00:00.000Z" }),
      sess({ id: "b", group: "build", jobType: "fix", claude: "cl-2", device: "dev-A", startedAt: "2026-06-03T19:10:00.000Z" }),
    ]);
    expect(t[1].freshReason).toBe("prior-failed");
  });

  it("degrades to 'unknown' (no badge, no throw) when group/claude are absent", () => {
    const t = deriveSessionTimeline([
      sess({ id: "legacy1", startedAt: "2026-06-03T18:00:00.000Z" }), // no metadata, no claude
      sess({ id: "legacy2", group: "build", jobType: "code", startedAt: "2026-06-03T18:10:00.000Z" }), // group but no claude
    ]);
    expect(t.map((e) => e.continuity)).toEqual(["unknown", "unknown"]);
    expect(t[0].groupLabel).toBeNull();
    expect(t[0].freshReason).toBeNull();
    expect(t[1].groupLabel).toBe("Build"); // still humanized for display
  });

  it("exposes short ids and hides raw values behind the short slice (AC8)", () => {
    const t = deriveSessionTimeline([
      sess({ id: "s1", group: "verify", jobType: "review", claude: "abcdef0123456789", device: "device-uuid-xyz", startedAt: "2026-06-03T20:00:00.000Z" }),
    ]);
    expect(t[0].claudeShort).toBe("abcdef01");
    expect(t[0].deviceShort).toBe("device-u");
  });
});
