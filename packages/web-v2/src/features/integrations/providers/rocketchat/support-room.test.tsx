import { type SupportRoomView, supportRoomConfigSchema } from "@forge/contracts/support";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import { bindingConfigOf, splitTiers, targetOf } from "../../binding-document";
import { stateOf, supportBlockOf, supportRoomErrors, supportSaveConfig } from "./support-room-config";
import { HealthCell, SupportRoomsRows } from "./support-rooms-table";

// A support room is set up in one save (REQ-75 r5 BC-25): the room and its support block written
// together, binding-tier, in the shape core's schema takes; and a room that is not answering says
// why, cause by cause (BC-26).

const filled = {
  ...stateOf(null, "6adec830b0d486d2c37383fa"),
  product: " Sidcorp Mail ",
  persona: "You are Babo, the assistant of the sid-email group. Answer in the thread.",
  readers: "team" as const,
  answers: "mentions" as const,
  abilities: ["run_commands", "read_checkout", "build"] as const,
  hosts: "mail-01, mta1 @mta6",
  confirmers: "@chuongld thanhnh",
};

describe("the support room's save", () => {
  it("writes the one room and the support block together, abilities in the contract's order", () => {
    const saved = supportSaveConfig({ ...filled, abilities: [...filled.abilities] });
    expect(saved).toEqual({
      rids: ["6adec830b0d486d2c37383fa"],
      support: {
        product: "Sidcorp Mail",
        persona: filled.persona,
        readers: "team",
        answers: "mentions",
        grants: {
          abilities: ["read_checkout", "build", "run_commands"],
          hosts: ["mail-01", "mta1", "mta6"],
          confirmers: ["chuongld", "thanhnh"],
        },
      },
    });
    expect(supportRoomConfigSchema.safeParse(saved.support).success).toBe(true);
  });

  it("writes it binding-tier, so the binding document carries `support` and keeps `operations`", () => {
    const saved = supportSaveConfig({ ...filled, abilities: [...filled.abilities] });
    const tiers = splitTiers("rocketchat", { serverUrl: "https://chat.example", ...saved });
    expect(tiers.connection).toEqual({ serverUrl: "https://chat.example" });
    expect(targetOf("rocketchat", tiers.binding, "")).toEqual({ provider: "rocketchat", ...saved });
    expect(bindingConfigOf({ provider: "rocketchat", rids: ["r"], operations: { scope: "project" } })).toEqual({
      rids: ["r"],
      operations: { scope: "project" },
    });
  });

  it("writes no grant for a room with no ability ticked, and carries the limits the form does not edit", () => {
    const block = supportBlockOf(stateOf(null, "r"), { limits: { messagesPerUserPerHour: 5 } });
    expect(block).toEqual({ readers: "users", answers: "every-message", limits: { messagesPerUserPerHour: 5 } });
  });

  it("names the field the schema refuses: a host list for run_commands, a confirmer, the group", () => {
    const errors = supportRoomErrors({ ...filled, rid: " ", abilities: ["run_commands"], hosts: "", confirmers: "" });
    expect(Object.keys(errors).sort()).toEqual(["confirmers", "hosts", "rid"]);
    expect(errors.hosts).toMatch(/names no host/);
  });

  it("reads a saved block back into the form it was written from", () => {
    const saved = supportSaveConfig({ ...filled, abilities: [...filled.abilities] });
    const back = stateOf(supportRoomConfigSchema.parse(saved.support), saved.rids[0] ?? "");
    expect(supportSaveConfig(back)).toEqual(saved);
  });
});

const room = (over: Partial<SupportRoomView>): SupportRoomView => ({
  id: "room-1",
  projectId: "p",
  bindingId: "b",
  rid: "6adf2217b0d486d2c373ca43",
  kind: "support",
  scope: null,
  role: null,
  sessionId: "s",
  sessionStatus: "completed",
  resident: true,
  principalUserId: "u",
  toolCount: 0,
  name: "sid-catalog",
  readers: "team",
  answers: "mentions",
  grants: { abilities: ["read_checkout", "file_items"] },
  health: { healthy: true, causes: [], checkedAt: "2026-10-28T10:00:00.000Z" },
  threads: 0,
  latency: {
    measured: 0,
    p50Ms: null,
    p95Ms: null,
    byPath: {
      start: { measured: 0, p50Ms: null, p95Ms: null },
      send: { measured: 0, p50Ms: null, p95Ms: null },
      inject: { measured: 0, p50Ms: null, p95Ms: null },
    },
  },
  createdAt: "2026-10-28T10:00:00.000Z",
  ...over,
});

describe("a room's health", () => {
  it("names every cause of an unhealthy room on a line of its own, code then detail", () => {
    renderWithQuery(
      <HealthCell
        health={{
          healthy: false,
          checkedAt: "2026-10-28T10:00:00.000Z",
          causes: [
            { code: "BOT_NOT_IN_ROOM", detail: "@babo is not a member of OrbitInternal; add it in Rocket.Chat" },
            { code: "NO_BOX", detail: "no online box of orbit can run the session" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Unhealthy")).toBeTruthy();
    expect(screen.getByText("BOT_NOT_IN_ROOM").parentElement?.textContent).toBe(
      "BOT_NOT_IN_ROOM — @babo is not a member of OrbitInternal; add it in Rocket.Chat",
    );
    expect(screen.getByText("NO_BOX")).toBeTruthy();
  });

  it("lists each room flat: its group, abilities, session and health", () => {
    renderWithQuery(
      <SupportRoomsRows
        rooms={[
          room({}),
          room({
            id: "room-2",
            name: null,
            rid: "6ae1a7f66562facf823f62a7",
            grants: null,
            resident: false,
            health: {
              healthy: false,
              checkedAt: "2026-10-28T10:00:00.000Z",
              causes: [{ code: "SESSION_NOT_LISTENING", detail: "the session is not resident on sid-xeon-1-dev" }],
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("sid-catalog")).toBeTruthy();
    expect(screen.getByText("read_checkout, file_items")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("6ae1a7f66562facf823f62a7")).toBeTruthy();
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.getByText("SESSION_NOT_LISTENING")).toBeTruthy();
  });
});
