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

// FB-591 on forge-dev 0.4.0-dev.616: #Forge-Communicate read "Members None … Product None" while its
// binding (an operations agent Forge answers, live on sid-xeon-1-dev since 2026-11-04) was in the same
// answer and drawn nowhere, and the page had no way back to Channels (ISS-1180).
const communicate: ChannelView = {
  rid: "6a95265c70ac333f6394dcfc",
  name: "Forge-Communicate",
  members: 0,
  rules: 0,
  commonIssues: 0,
  agent: { kind: "channel", role: "operations", channel: "6a95265c70ac333f6394dcfc", answeredBy: "forge", box: "sid-xeon-1-dev", address: "forge-session:5b0c7a52-1f43-4c55-9d43-0d3c1a7f0e11", terminal: null, since: "2026-11-04T06:12:00Z" },
  memberRows: [],
  ruleRows: [],
  commonIssueRows: [],
  routes: [
    { route: "forge", members: [] },
    { route: "technical", members: [] },
    { route: "product", members: [] },
  ],
};

describe("who answers a channel, and an empty record (ISS-1180)", () => {
  it("leads with the agent answering the room and whether it is live, its turns one click away, and goes back to Channels", async () => {
    fakeCore((c) => (c.method === "GET" ? { body: { channel: communicate } } : undefined));
    renderWithQuery(<ChannelScreen projectId="p1" slug="forge" rid={communicate.rid} />);
    const who = await screen.findByTestId("channel-agent");
    expect(who).toHaveTextContent("Operations agent");
    expect(within(who).getByTestId("channel-agent-live")).toHaveTextContent("Live");
    expect(within(who).getByRole("link", { name: "Recent turns" }).getAttribute("href")).toBe("/projects/forge/agents/5b0c7a52-1f43-4c55-9d43-0d3c1a7f0e11");
    expect(who.textContent, "the session's address is a raw id, never text").not.toContain("forge-session:");
    expect(screen.getByTestId("detail-back").getAttribute("href")).toBe("/projects/forge/channels");
    // forge-dev at 390, 2026-11-09: the header held the back arrow alone; below 1152px of column the
    // title heads the main column, so the channel's name is in the first view on a phone (ISS-1184 item 8)
    expect(screen.getByTestId("detail-mobile-title")).toHaveTextContent("#Forge-Communicate");
  });

  it("reads a room nobody answers as not live, never as a blank", async () => {
    fakeCore((c) => (c.method === "GET" ? { body: { channel: { ...communicate, agent: null } } } : undefined));
    renderWithQuery(<ChannelScreen projectId="p1" slug="forge" rid={communicate.rid} />);
    const who = await screen.findByTestId("channel-agent");
    expect(within(who).getByTestId("channel-agent-live")).toHaveTextContent("Not live");
    expect(within(who).queryByRole("link", { name: "Recent turns" })).toBeNull();
  });

  it('reads an empty record as "Not recorded yet", never "None", beside the act that fills it', async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET") return { body: { channel: communicate } };
      if (c.method === "PUT") return { body: { member: { username: "chuongld", roles: ["technical"], state: "confirmed", askFor: null, confirmedBy: "Owner", updatedAt: "2026-11-09T08:00:00Z" } } };
      if (c.method === "POST") return { status: 201, body: { rule: { id: "r1", text: "Answer in Vietnamese." } } };
      return undefined;
    });
    renderWithQuery(<ChannelScreen projectId="p1" slug="forge" rid={communicate.rid} />);
    await screen.findByTestId("channel-agent");
    expect(document.body.textContent).not.toMatch(/\bNone\b/);
    expect(screen.getAllByText("Not recorded yet").length).toBeGreaterThanOrEqual(3);

    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Username" }), { target: { value: "@chuongld" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Technical" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.path).toBe(`/projects/p1/support/channels/${communicate.rid}/members/chuongld`);

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rule" }), { target: { value: "Answer in Vietnamese." } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/projects/p1/support/channels/${communicate.rid}/rules`);
    expect(post?.body).toEqual({ text: "Answer in Vietnamese." });
  });

  // forge-dev, 2026-11-09: Common issues read "Not recorded yet" with no act beside it, because no
  // write route existed (ISS-1184 item 6): the empty record offers the one act that fills it
  it("fills an empty Common issues from the page, a question and its one answer", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET") return { body: { channel: communicate } };
      if (c.method === "POST") return { status: 201, body: { commonIssue: { id: "c1", question: "How do I reset my password?", answer: "Settings, then Password." } } };
      return undefined;
    });
    renderWithQuery(<ChannelScreen projectId="p1" slug="forge" rid={communicate.rid} />);
    const section = await screen.findByRole("region", { name: "Common issues" });
    fireEvent.click(within(section).getByRole("button", { name: "Add common issue" }));
    fireEvent.change(within(section).getByRole("textbox", { name: "Question" }), { target: { value: "How do I reset my password?" } });
    fireEvent.change(within(section).getByRole("textbox", { name: "Answer" }), { target: { value: "Settings, then Password." } });
    fireEvent.click(within(section).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/projects/p1/support/channels/${communicate.rid}/common-issues`);
    expect(post?.body).toEqual({ question: "How do I reset my password?", answer: "Settings, then Password." });
  });
});

describe("a bound channel's page (REQ-75 r6)", () => {
  it("lists the project's bound channels by name with their counts", async () => {
    fakeCore((c) => (c.path === "/projects/p1/support/channels" ? { body: { channels: [{ rid: webmail.rid, name: "webmail", members: 2, rules: 1, commonIssues: 1 }] } } : undefined));
    renderWithQuery(<ChannelsScreen projectId="p1" slug="mail" />);
    const link = await screen.findByRole("link", { name: /#webmail/ });
    expect(link.getAttribute("href")).toContain(`/projects/mail/channels/${webmail.rid}`);
  });

  it("lists the channels on the shared grouped list, a name leading each row and only the counts that hold something (ISS-1072)", async () => {
    fakeCore((c) =>
      c.path === "/projects/p1/support/channels"
        ? { body: { channels: [{ rid: webmail.rid, name: "webmail", members: 2, rules: 0, commonIssues: 1 }, { rid: "GENERAL-rid-1", name: null, members: 0, rules: 0, commonIssues: 0 }] } }
        : undefined,
    );
    renderWithQuery(<ChannelsScreen projectId="p1" slug="mail" />);
    const list = await screen.findByTestId("grouped-list");
    expect(screen.queryByRole("table")).toBeNull();
    const rows = within(list).getAllByTestId("list-row");
    expect(rows.map((r) => r.querySelector(".truncate")?.textContent)).toEqual(["#webmail", "Unnamed channel"]);
    expect(within(rows[0]).getByTestId("row-facts").textContent).toBe("2 members·1 common issue");
    expect(within(rows[1]).queryByTestId("row-facts")).toBeNull();
    expect(list.textContent).not.toContain("GENERAL-rid-1");
    fireEvent.click(rows[0]);
    await waitFor(() => expect(window.location.pathname).toBe(`/projects/mail/channels/${webmail.rid}`));
  });

  // the list read carried no agent, so a row could not say who answers the room (ISS-1184 item 5)
  it("shows on each row the agent answering the room and whether it is live", async () => {
    const { memberRows: _m, ruleRows: _r, commonIssueRows: _c, routes: _routes, ...summary } = communicate;
    fakeCore((c) =>
      c.path === "/projects/p1/support/channels"
        ? { body: { channels: [summary, { rid: webmail.rid, name: "webmail", members: 2, rules: 0, commonIssues: 1, agent: null }] } }
        : undefined,
    );
    renderWithQuery(<ChannelsScreen projectId="p1" slug="forge" />);
    const list = await screen.findByTestId("grouped-list");
    const [answered, quiet] = within(list).getAllByTestId("list-row");
    expect(within(answered).getByTestId("channel-row-agent")).toHaveTextContent("Operations agent");
    expect(within(answered).getByTestId("channel-agent-live")).toHaveTextContent("Live");
    expect(within(quiet).queryByTestId("channel-row-agent")).toBeNull();
    expect(within(quiet).getByTestId("channel-agent-live")).toHaveTextContent("Not live");
    expect(list.textContent, "the session's address is a raw id, never text").not.toContain("forge-session:");
  });

  it("shows Members, Rules, Common issues and Routes as four flat tables", async () => {
    fakeCore((c) => (c.method === "GET" ? { body: { channel: webmail } } : undefined));
    renderWithQuery(<ChannelScreen projectId="p1" slug="mail" rid={webmail.rid} />);
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
    renderWithQuery(<ChannelScreen projectId="p1" slug="mail" rid={webmail.rid} />);
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
