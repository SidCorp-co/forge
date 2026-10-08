// The loop back to the reporter: the page leads with where the item stands, when the forecast expects
// it and the release that shipped it; a reporter no bell reaches is told by a person, who records the
// relay from the composer; the rail says how the reporter heard it.

import type { FeedbackForecast } from "@forge/contracts/forecast";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { say, sentence } from "@/test/said";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackActions } from "./feedback-actions";
import { FeedbackAnswer } from "./feedback-answer";
import { FeedbackFacts } from "./feedback-facts";
import { Messages } from "./feedback-messages";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-10-08T03:00:00.000Z");
const CLOCK = { lang: "en" as const, now: NOW, timeZone: "UTC" };
const CAN = { triage: false, verify: true, reopen: true, askVerify: true, redact: false, retarget: false, accept: false, snooze: false, message: true, tellShipped: false, note: true, attach: false };
const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-4",
    kind: "bug",
    severity: "medium",
    phase: "resolved",
    status: "triaged",
    attentionGroup: "needs_you",
    waitingOn: { kind: "you", who: "You", act: "tell Ana that it shipped in 0.4.2", rule: "r", ref: "0.4.2", dueAt: null },
    target: { type: "screen", key: "The board", title: null },
    route: { route: "issue", carriers: [{ key: "ISS-9", status: "closed", release: "0.4.2" }], answer: null },
    reporter: { id: "u9", name: "Ana", agency: "agent" },
    whereSeen: null,
    duplicates: [],
    source: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    can: CAN,
    openSuggestions: 0,
    reporters: [{ id: "u9", name: "Ana", agency: "agent", from: null }],
    messages: [],
    verified: null,
    autoVerify: null,
    snoozed: null,
    shipNotice: {
      state: "not_told",
      reason: sentence(say("feedback.notice.agent")),
      says: { reason: say("feedback.notice.agent") },
      shipped: { at: "2026-10-07T09:00:00.000Z", release: "0.4.2" },
      beforeNotices: false,
      noticesBegan: null,
    },
    attachments: [],
    decisions: [],
    ...over,
  }) as unknown as FeedbackView;

const forecast = (p50At: string): FeedbackForecast =>
  ({
    key: "FB-4",
    triage: null,
    delivery: {
      label: "forecast",
      asOf: new Date(NOW).toISOString(),
      landing: {
        label: "forecast",
        asOf: new Date(NOW).toISOString(),
        kind: "forecast",
        p50At,
        p85At: p50At,
        p50Minutes: 60,
        p85Minutes: 60,
        ahead: 0,
        aheadKeys: [],
        waitsOn: [],
        late: null,
        basis: { n: 45, floor: 10, windowDays: 60, complexity: null, cycleP50Minutes: 35, cycleP85Minutes: 240, throughputPerDay: 12.4, concurrency: 1, concurrencyBasis: "Little's law" },
      },
      release: null,
      inHands: { p50At, p85At: p50At, p50Minutes: 60, p85Minutes: 60 },
      shipped: null,
    },
  }) as unknown as FeedbackForecast;

describe("the page leads with the reporter's answer", () => {
  it("names the release that shipped it and the day, linked to that release", () => {
    renderWithQuery(<FeedbackAnswer f={view()} slug="hop" forecast={undefined} clock={CLOCK} />);
    const line = screen.getByTestId("feedback-answer-line");
    expect(line).toHaveTextContent(/^Shipped in 0\.4\.2 on .+\.$/);
    expect(screen.getByRole("link", { name: "0.4.2" })).toHaveAttribute("href", expect.stringContaining("0.4.2"));
  });

  it("says when the forecast expects work that is still moving", () => {
    renderWithQuery(<FeedbackAnswer f={view({ phase: "planned", shipNotice: null })} slug="hop" forecast={forecast("2026-10-08T05:30:00.000Z")} clock={CLOCK} />);
    expect(screen.getByTestId("feedback-answer-line")).toHaveTextContent("Being worked on, expected 05:30");
  });

  it("says it plainly with no forecast, and in the reader's language", () => {
    renderWithQuery(
      <InterfaceLanguageScope language="vi">
        <FeedbackAnswer f={view({ phase: "verified", status: "verified" })} slug="hop" forecast={undefined} clock={{ ...CLOCK, lang: "vi" }} />
      </InterfaceLanguageScope>,
    );
    const line = screen.getByTestId("feedback-answer-line");
    expect(line).toHaveTextContent("0.4.2");
    expect(line.textContent).not.toMatch(/\b(Shipped|confirmed)\b/);
  });
});

describe("a reporter no bell reaches is told by a person", () => {
  it("opens the composer on the relay, records it with no preview and sends relayed", async () => {
    const calls = fakeCore(() => ({ body: { feedback: view() } }));
    renderWithQuery(<Messages projectId="p1" f={view()} />);
    expect(screen.getByRole("radio", { name: "I told them myself" })).toBeChecked();
    expect(screen.getByTestId("feedback-composer")).toHaveTextContent("no notice is sent");
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "I told them myself" }), { target: { value: "Told Ana on the support call." } });
    fireEvent.click(screen.getByTestId("feedback-record-relay"));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/feedback/FB-4/messages", body: { audience: "reporter", text: "Told Ana on the support call.", relayed: true } },
      ]),
    );
  });

  it("shows a recorded relay on the thread as told outside Forge", () => {
    const relay = { id: "m1", audience: "reporter", text: "Told Ana on the call.", sentBy: "u1", sentByName: "Dana", sentAgency: "human", sentAt: "2026-10-07T10:00:00.000Z", recipients: [], relayed: true, writtenLang: "en" };
    renderWithQuery(<Messages projectId="p1" f={view({ messages: [relay] as FeedbackView["messages"] })} />);
    expect(screen.getByTestId("feedback-relayed")).toHaveTextContent("Told outside Forge");
  });

  it("says in the rail who told the reporter, and how", () => {
    renderWithQuery(
      <FeedbackFacts
        f={view({ shipNotice: {
            state: "told",
            how: "relayed",
            at: "2026-10-07T10:00:00.000Z",
            release: "0.4.2",
            by: "Dana",
            shipped: { at: "2026-10-07T09:00:00.000Z", release: "0.4.2" },
            told: sentence(say("feedback.told.relayed", { by: "Dana" })),
            says: { told: say("feedback.told.relayed", { by: "Dana" }) },
          }, })}
        slug="hop"
      />,
    );
    expect(screen.getByTestId("ship-notice-how")).toHaveTextContent("Dana told them outside Forge");
  });
});

describe("an item shipped before release notices existed is told on purpose, by anyone who wants to", () => {
  const legacy = {
    state: "not_told" as const,
    reason: sentence(say("feedback.notice.before", { date: "2026-10-07" })),
    says: { reason: say("feedback.notice.before", { date: "2026-10-07" }) },
    shipped: { at: "2026-10-01T09:00:00.000Z", release: "0.3.0" },
    beforeNotices: true,
    noticesBegan: "2026-10-07T07:39:54.217Z",
  };

  it("offers Tell the reporter now and sends it to core", async () => {
    const calls = fakeCore(() => ({ body: { feedback: view() } }));
    renderWithQuery(<FeedbackActions projectId="p1" f={view({ shipNotice: legacy, can: { ...CAN, verify: false, reopen: false, askVerify: false, tellShipped: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Tell the reporter now" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/projects/p1/feedback/FB-4/tell-shipped", body: {} }]));
  });

  it("offers nothing to tell where the reporter was told", () => {
    renderWithQuery(<FeedbackActions projectId="p1" f={view({ can: { ...CAN, verify: false, reopen: false, askVerify: false, tellShipped: false } })} />);
    expect(screen.queryByTestId("feedback-tell-shipped")).toBeNull();
  });
});
