import type { ProjectStatus } from "@forge/contracts/project-status";
import { verbatim } from "@forge/contracts/said";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { AT, STATUS } from "../status-fixture";
import { StatusReport } from "./status-report";

// The HOP journey walk (2026-10-08): a person reading /status could not tell what they owe, what was
// proven or why a date moved. Each is core's; the page says it in the reader's language.

const clock = { lang: "vi" as const, now: Date.parse(AT), timeZone: "UTC" };
const minh = waitingOn("person", { who: say("standing.who.named", { name: "Minh" }), act: say("standing.act.approve"), rule: RULE });
const you = STATUS.waits.people[0]?.waitingOn ?? minh;
const ask = (key: string, w: typeof minh) => ({ area: "designs" as const, entity: "workflow" as const, key, title: key, titleLang: null, says: { title: verbatim(key) }, touchedAt: AT, waitingOn: w });

const s: ProjectStatus = {
  ...STATUS,
  shipped: {
    ...STATUS.shipped,
    requirementsAwaitingProof: [{ key: "REQ-23", title: "Derived state", at: AT, proven: 0, total: 7 }],
  },
  waits: {
    ...STATUS.waits,
    people: [...STATUS.waits.people, ask("hop-intake", minh), ask("hop-recall-ux", minh)],
    byPerson: [
      { kind: "you", who: "You", says: { who: you.says.who }, count: 1 },
      { kind: "person", who: "Minh", says: { who: minh.says.who }, count: 2 },
    ],
    peopleCount: 3,
  },
  roadmap: {
    ...STATUS.roadmap,
    now: [
      {
        key: "REQ-4",
        title: "Referrals",
        state: "in_delivery",
        delivery: null,
        deferral: null,
        moved: {
          fromAt: "2026-10-08T09:00:00.000Z",
          fromP50At: "2026-10-08T12:28:00.000Z",
          fromP85At: "2026-10-08T18:42:00.000Z",
          at: "2026-10-08T09:30:00.000Z",
          toP50At: "2026-10-08T14:34:00.000Z",
          toP85At: "2026-10-09T01:21:00.000Z",
          byMinutes: 126,
          because: say("forecast.event.transition", { key: "ISS-88", status: "awaiting_release" }),
        },
      },
    ],
  },
};

function shown() {
  renderWithQuery(
    <InterfaceLanguageScope language="vi">
      <StatusReport s={s} slug="hop" clock={clock} window="7" onWindow={() => {}} />
    </InterfaceLanguageScope>,
  );
}

describe("what a person reads on /status", () => {
  it("groups the asks by the person who owes them, in Vietnamese", () => {
    shown();
    const groups = within(screen.getByTestId("status-waits")).getAllByTestId("status-wait-person");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("Bạn · 1"); // i18n-allow: Vietnamese text under test
    expect(groups[1]).toHaveTextContent("Minh · 2");
    expect(groups[1]).toHaveTextContent("hop-recall-ux");
  });

  it("never calls a shipped requirement with unproven criteria delivered in full", () => {
    shown();
    expect(screen.getByTestId("status-awaiting-proof")).toHaveTextContent("REQ-23");
    expect(screen.getByTestId("status-awaiting-proof")).toHaveTextContent("0/7");
  });

  it("says how far a forecast moved and the event that moved it", () => {
    shown();
    const line = within(screen.getByTestId("status-roadmap")).getByTestId("forecast-honesty");
    expect(line.textContent).toMatch(/^dời 2,1 giờ vì ISS-88 chuyển sang /); // i18n-allow: Vietnamese text under test
  });
});
