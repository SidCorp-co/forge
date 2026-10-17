// ISS-1421 r5 — right after Connect Coolify saved, the Status list read Coolify but the drawer the
// save was made in still read Not connected: it showed the card it was opened with.

import { describe, expect, it } from "vitest";
import type { StatusCard } from "../types";
import { liveCard } from "./project-integrations-panel";

const card = (key: string, status: StatusCard["status"]): StatusCard => ({
  key,
  label: key,
  status,
  detail: "",
  lastSyncAt: null,
  configured: status !== "not_configured",
});

describe("liveCard", () => {
  it("shows the state the list holds now, not the one the drawer was opened at", () => {
    const opened = card("coolify", "not_configured");
    const now = [card("github", "not_configured"), card("coolify:preview", "error")];
    expect(liveCard(opened, now)).toEqual(now[1]);
  });

  it("keeps the stage it was opened at when the provider's one card names another", () => {
    const opened = card("coolify:live", "not_configured");
    const shown = liveCard(opened, [card("coolify:preview", "connected")]);
    expect(shown?.key).toBe("coolify:live");
    expect(shown?.status).toBe("connected");
  });

  it("takes the exact card where the provider has several", () => {
    const now = [card("coolify:preview", "error"), card("coolify:live", "connected")];
    expect(liveCard(card("coolify:live", "not_configured"), now)).toEqual(now[1]);
  });

  it("keeps what it was opened with where the list cannot say which card it is", () => {
    const opened = card("coolify", "not_configured");
    const now = [card("coolify:preview", "error"), card("coolify:live", "connected")];
    expect(liveCard(opened, now)).toBe(opened);
    expect(liveCard(null, now)).toBeNull();
  });
});
