// A project's Forge Boxes as core answers them (ISS-1276), shaped after mockup MK-12: an android box
// an agent drives, a browser box a person holds, one more agent box, one done, and two requests
// waiting on the device's health. Shared by the Boxes tests and the page's screen witness.

import type { BoxActRecord, BoxRecord, BoxSpanRecord } from "@forge/contracts/boxes";

export const PROJECT_ID = "6f1c2a7e-0b8d-4c3e-9a51-2d4e6f8a0b1c";
export const DEVICE_ID = "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
export const ME = "u-me";
export const OWNER = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";

const id = (n: number) => `b0c0${String(n).padStart(4, "0")}-0000-4000-8000-00000000000${n}`;
export const BOX = { android: id(1), held: id(2), admin: id(3), done: id(4), waitA: id(5), waitB: id(6), mine: id(7) } as const;
export const ISSUE = { rewards: id(11), order: id(12), report: id(13), login: id(14), print: id(15), menu: id(16) } as const;

export const ISSUE_LABELS: Record<string, { displayId: string; title: string }> = {
  [ISSUE.rewards]: { displayId: "ISS-12", title: "Redeem points at the counter" },
  [ISSUE.order]: { displayId: "ISS-9", title: "Order by table (guest web)" },
  [ISSUE.report]: { displayId: "ISS-7", title: "Shift report (admin)" },
  [ISSUE.login]: { displayId: "ISS-5", title: "Owner sign-in" },
  [ISSUE.print]: { displayId: "ISS-14", title: "Bill does not print" },
  [ISSUE.menu]: { displayId: "ISS-15", title: "Menu photos" },
};

const ago = (now: number, ms: number) => new Date(now - ms).toISOString();

function box(now: number, over: Partial<BoxRecord> & Pick<BoxRecord, "id" | "mode" | "state">): BoxRecord {
  return {
    deviceId: DEVICE_ID,
    projectId: PROJECT_ID,
    issueId: null,
    criterion: null,
    holder: over.state === "agent" ? { kind: "agent", runId: "run-qa" } : null,
    heldSince: over.state === "agent" ? ago(now, 252_000) : null,
    queue: null,
    viewport: null,
    url: null,
    view: null,
    recording: null,
    failure: null,
    detail: null,
    openedBy: "agent:run-qa",
    createdAt: ago(now, 260_000),
    closedAt: null,
    ...over,
  };
}

/** The project's boxes at `now`; `heldByMe` makes the held box this reader's own hold. */
export function projectBoxes(now = Date.now(), heldByMe = false): BoxRecord[] {
  return [
    box(now, {
      id: BOX.android,
      mode: "android",
      state: "agent",
      issueId: ISSUE.rewards,
      criterion: 2,
      view: { codec: "scrcpy-h264", width: 1080, height: 2400 },
      recording: { state: "recording", why: "span", startedAt: ago(now, 12_000) },
    }),
    box(now, {
      id: BOX.held,
      mode: "browser",
      state: "person",
      issueId: ISSUE.order,
      holder: heldByMe ? { kind: "person", userId: ME, name: "Me" } : { kind: "person", userId: OWNER, name: "Chuong" },
      heldSince: ago(now, 100_000),
      viewport: { width: 390, height: 844 },
      view: { codec: "jpeg-frames", width: 390, height: 844 },
    }),
    box(now, { id: BOX.admin, mode: "browser", state: "agent", issueId: ISSUE.report, criterion: 1, viewport: { width: 1440, height: 900 }, view: { codec: "jpeg-frames", width: 1440, height: 900 } }),
    box(now, { id: BOX.done, mode: "android", state: "closed", issueId: ISSUE.login, recording: { state: "kept", why: null, startedAt: ago(now, 3_600_000) }, closedAt: ago(now, 1_800_000) }),
    box(now, { id: BOX.waitB, mode: "browser", state: "waiting", issueId: ISSUE.menu, queue: { position: 2, reason: "CPU pressure 82% is over the 70% ceiling" } }),
    box(now, { id: BOX.waitA, mode: "android", state: "waiting", issueId: ISSUE.print, queue: { position: 1, reason: "available memory 12 GB is under the 16 GB reserve" } }),
  ];
}

function act(now: number, boxId: string, seq: number, over: Partial<BoxActRecord> & Pick<BoxActRecord, "command">): BoxActRecord {
  return {
    id: `a0c0${String(seq).padStart(4, "0")}-0000-4000-8000-${boxId.slice(-12)}`,
    boxId,
    seq,
    by: "agent",
    actor: "agent:run-qa",
    kind: "write",
    state: "done",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 120,
    refusal: null,
    at: ago(now, 252_000 - seq * 30_000),
    ...over,
  };
}

/** The android box's feed: the agent's commands, one still running. */
export function androidActs(now = Date.now()): BoxActRecord[] {
  return [
    act(now, BOX.android, 1, { command: ["snapshot", "-i"], kind: "read" }),
    act(now, BOX.android, 2, { command: ["fill", "@e14", "0901 234 567"] }),
    act(now, BOX.android, 3, { command: ["click", "@e22"] }),
    act(now, BOX.android, 4, { command: ["fill", "@e30", "45000"] }),
    act(now, BOX.android, 5, { command: ["click", "@e33"], state: "pending", exitCode: null, durationMs: null }),
  ];
}

/** The held box's feed: the person's tap, and the agent's click refused while they hold it. */
export function heldActs(now = Date.now()): BoxActRecord[] {
  return [
    act(now, BOX.held, 1, { by: "person", actor: `person:${OWNER}`, kind: "input", command: [JSON.stringify({ t: "tap", x: 0.42, y: 0.61 })], at: ago(now, 40_000) }),
    act(now, BOX.held, 2, { command: ["click", "@e9"], state: "refused", exitCode: null, refusal: "BOX_HELD_BY_PERSON", at: ago(now, 20_000) }),
  ];
}

export function androidSpans(now = Date.now()): BoxSpanRecord[] {
  return [
    { id: id(21), boxId: BOX.android, issueId: ISSUE.rewards, criterion: 1, state: "attached", startedAt: ago(now, 240_000), endedAt: ago(now, 200_000), clipAttachmentId: id(31), stillAttachmentId: id(32), detail: null },
    { id: id(22), boxId: BOX.android, issueId: ISSUE.rewards, criterion: 2, state: "open", startedAt: ago(now, 150_000), endedAt: null, clipAttachmentId: null, stillAttachmentId: null, detail: null },
  ];
}
