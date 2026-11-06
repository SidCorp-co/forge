import type { ChannelView } from "@forge/contracts/support-channel";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ChannelScreen } from "./channel-screen";
import { ChannelsScreen } from "./channels-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

// Product → Channels (REQ-75 r6 BC-30): the project's bound channels, and one channel's record as
// four flat tables — Members, Rules, Common issues, Routes — a member's roles reading inferred or
// confirmed, a person's correction confirming them (BC-31..BC-33).

const webmail: ChannelView = {
  rid: "6ae2c51c6562facf823fa703",
  name: "webmail",
  members: 2,
  rules: 1,
  commonIssues: 1,
  agent: null,
  memberRows: [
    { username: "thanhnh", roles: ["technical", "product"], state: "confirmed", askFor: "node changes, deploys", confirmedBy: "Owner", updatedAt: "2026-10-29T08:00:00Z" },
    { username: "tramnnh", roles: ["user"], state: "inferred", askFor: null, confirmedBy: null, updatedAt: "2026-10-29T08:00:00Z" },
  ],
  ruleRows: [{ id: "r1", text: "Answer users in plain Vietnamese.", author: "chuongld", message: "m1", thread: "t1", createdAt: "2026-10-29T08:00:00Z" }],
  commonIssueRows: [{ id: "c1", question: "How do I reset my password?", answer: "Settings, then Password.", threads: 3, feedbackKey: "FB-12", updatedAt: "2026-10-29T08:00:00Z" }],
  routes: [
    { route: "forge", members: [] },
    { route: "technical", members: ["thanhnh"] },
    { route: "product", members: ["thanhnh"] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("a bound channel's page (REQ-75 r6)", () => {
  it("lists the project's bound channels by name with their counts", async () => {
    fakeCore((c) => (c.path === "/projects/p1/support/channels" ? { body: { channels: [{ rid: webmail.rid, name: "webmail", members: 2, rules: 1, commonIssues: 1 }] } } : undefined));
    renderWithQuery(<ChannelsScreen projectId="p1" slug="mail" />);
    const link = await screen.findByRole("link", { name: "#webmail" });
    expect(link.getAttribute("href")).toContain(`/projects/mail/channels/${webmail.rid}`);
  });

  it("shows Members, Rules, Common issues and Routes as four flat tables", async () => {
    fakeCore((c) => (c.method === "GET" ? { body: { channel: webmail } } : undefined));
    renderWithQuery(<ChannelScreen projectId="p1" rid={webmail.rid} />);
    for (const name of ["Members", "Rules", "Common issues", "Routes"]) {
      expect(await screen.findByRole("table", { name })).toBeTruthy();
    }
    const members = screen.getByRole("table", { name: "Members" });
    expect(within(members).getByText("Technical + Product")).toBeTruthy();
    expect(within(members).getByText("Confirmed")).toBeTruthy();
    expect(within(members).getByText("Inferred")).toBeTruthy();
    const routes = screen.getByRole("table", { name: "Routes" });
    expect(within(routes).getByText("Forge master")).toBeTruthy();
    expect(within(routes).getAllByText("@thanhnh")).toHaveLength(2);
    expect(within(screen.getByRole("table", { name: "Common issues" })).getByText("FB-12")).toBeTruthy();
  });

  it("confirms a member's roles a person corrects, in the contract's role order", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET") return { body: { channel: webmail } };
      if (c.method === "PUT") return { body: { member: { ...webmail.memberRows[1], state: "confirmed" } } };
      return undefined;
    });
    renderWithQuery(<ChannelScreen projectId="p1" rid={webmail.rid} />);
    const members = await screen.findByRole("table", { name: "Members" });
    const [, second] = within(members).getAllByRole("button", { name: "Edit" });
    if (second) fireEvent.click(second);
    fireEvent.click(screen.getByRole("checkbox", { name: "Product" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask for" }), { target: { value: "what she sees in webmail" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/projects/p1/support/channels/${webmail.rid}/members/tramnnh`);
    expect(put?.body).toEqual({ roles: ["user", "product"], askFor: "what she sees in webmail" });
  });
});
