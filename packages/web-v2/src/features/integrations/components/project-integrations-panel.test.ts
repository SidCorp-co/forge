// ISS-1421 r5 — right after Connect Coolify saved, the Status list read Coolify but the drawer the
// save was made in still read Not connected: it showed the card it was opened with.

import { describe, expect, it } from "vitest";
import type { StatusCard } from "../types";
import { cardForLink, liveCard } from "./project-integrations-panel";

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

  it("reads a stage from the card that serves it, keeping the stage it was opened at", () => {
    const shown = liveCard(card("coolify:live", "not_configured"), [
      card("coolify:preview+live", "connected"),
    ]);
    expect(shown?.key).toBe("coolify:live");
    expect(shown?.status).toBe("connected");
  });

  // Consult F1: deleting Preview from its open drawer left only Live, whose state the drawer took.
  it("reads a stage no card serves as not set up, never as another stage's state", () => {
    const shown = liveCard(card("coolify:preview", "connected"), [card("coolify:live", "connected")]);
    expect(shown?.key).toBe("coolify:preview");
    expect(shown?.status).toBe("not_configured");
    expect(shown?.configured).toBe(false);
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

  // ISS-1421 r34: a row's drawer holds its own binding; the key the list gives it can change under it.
  const bound = (key: string, bindingId: string, status: StatusCard["status"]): StatusCard => ({
    ...card(key, status),
    meta: { bindingId },
  });

  it("follows its row's binding when the list gives that binding another key", () => {
    const opened = bound("sentry:service:b1", "b1", "error");
    const shown = liveCard(opened, [bound("sentry", "b1", "connected")]);
    expect(shown?.status).toBe("connected");
    expect(shown?.meta?.bindingId).toBe("b1");
    expect(shown?.key).toBe("sentry:service:b1");
  });

  it("reads a row whose binding the list no longer holds as not set up, never as another binding at its stage", () => {
    const opened = bound("sentry:service:b1", "b1", "error");
    const shown = liveCard(opened, [bound("sentry:service:b2", "b2", "connected"), bound("sentry:service:b3", "b3", "connected")]);
    expect(shown?.status).toBe("not_configured");
    expect(shown?.meta?.bindingId).toBe("b1");
  });
});

// ISS-1421 r34: a drawer follows the binding its card names, so a link to one stage must not hand it the
// binding of a card serving another.
describe("cardForLink", () => {
  const bound = (key: string, bindingId: string): StatusCard => ({
    ...card(key, "connected"),
    meta: { bindingId },
  });

  it("opens the card serving the stage the link names, under that stage's key", () => {
    const shown = cardForLink([bound("coolify:preview", "p"), bound("coolify:live", "l")], "coolify", "live");
    expect(shown?.key).toBe("coolify:live");
    expect(shown?.meta?.bindingId).toBe("l");
  });

  it("lends no binding where no card serves that stage, so it reads as not set up", () => {
    const opened = cardForLink([bound("coolify:preview", "p")], "coolify", "live");
    expect(opened?.key).toBe("coolify:live");
    expect(opened?.meta?.bindingId).toBeUndefined();
    expect(liveCard(opened, [bound("coolify:preview", "p")])?.status).toBe("not_configured");
  });

  it("opens the provider's card as it is where the link names no stage, and none for a provider with no card", () => {
    expect(cardForLink([bound("sentry", "s")], "sentry")?.meta?.bindingId).toBe("s");
    expect(cardForLink([bound("sentry", "s")], "postman")).toBeNull();
  });
});
